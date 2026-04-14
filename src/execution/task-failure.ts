/**
 * Task failure handler — the ~180-LOC catch block inside
 * RuntimeEngine.executeTask. Handles retry-with-backoff for transient
 * errors, persists failure status + categorized error, resets agent
 * state, reports to cloud, fires fire-and-forget anomaly detection and
 * root-cause enrichment, and drains the queue if Ollama is the only
 * provider and it's down.
 *
 * Extracted using the `this: RuntimeEngine` pattern so `this.db`,
 * `this.config`, `this.modelRouter`, `this.effects`, `this.emit`,
 * `this.semaphore`, `this.executeTask` (for retry re-entry), and
 * `this.collectStateUpdates` all stay accessible.
 *
 * The outer `finally { this.semaphore.release() }` stays in
 * executeTask — retry path bypasses it by returning early from the
 * catch. Non-retry failures fall through the catch's return and then
 * the finally runs on the way out.
 */

import type { RuntimeEngine } from './engine.js';
import type { ExecuteAgentResult } from './types.js';
import { classifyError, isRetryableFailure } from '../lib/error-classification.js';
import { classifyRootCause } from '../lib/failure-root-cause.js';
import { detectAndPersistAnomalies } from './anomaly-monitoring.js';
import { logger } from '../lib/logger.js';

export interface HandleTaskFailureArgs {
  error: unknown;
  taskId: string;
  agentId: string;
  workspaceId: string;
  taskTitle: string;
  startTime: number;
}

export async function handleTaskFailure(
  this: RuntimeEngine,
  args: HandleTaskFailureArgs,
): Promise<ExecuteAgentResult> {
  const { error, taskId, agentId, workspaceId, taskTitle, startTime } = args;
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  const durationSeconds = Math.round((Date.now() - startTime) / 1000);

  // Update task as failed with categorized error
  const failureCategory = classifyError(error);

  // Auto-retry for transient errors (rate limits, timeouts)
  if (isRetryableFailure(failureCategory)) {
    try {
      const { data: retryTask } = await this.db
        .from('agent_workforce_tasks')
        .select('retry_count, max_retries')
        .eq('id', taskId)
        .single();
      const retryCount = (retryTask as { retry_count: number; max_retries: number } | null)?.retry_count ?? 0;
      const maxRetries = (retryTask as { retry_count: number; max_retries: number } | null)?.max_retries ?? 3;

      if (retryCount < maxRetries) {
        const backoffMs = Math.pow(2, retryCount + 1) * 1000; // 2s, 4s, 8s
        const scheduledFor = new Date(Date.now() + backoffMs).toISOString();

        await this.db.from('agent_workforce_tasks').update({
          status: 'pending',
          retry_count: retryCount + 1,
          error_message: `Retry ${retryCount + 1}/${maxRetries}: ${errorMessage}`,
          updated_at: new Date().toISOString(),
          scheduled_for: scheduledFor,
        }).eq('id', taskId);

        // Reset agent to idle so it can pick up the retry
        await this.db.from('agent_workforce_agents').update({
          status: 'idle',
          updated_at: new Date().toISOString(),
        }).eq('id', agentId).then(() => {}, () => {});

        this.emit('task:retried', { taskId, agentId, retryCount: retryCount + 1, maxRetries });

        // Schedule re-execution after backoff
        setTimeout(() => {
          this.executeTask(agentId, taskId).catch(() => {});
        }, backoffMs);

        return {
          success: false,
          taskId,
          status: 'pending',
          error: `Retrying (${retryCount + 1}/${maxRetries}): ${errorMessage}`,
          tokensUsed: 0,
          costCents: 0,
        };
      }
    } catch {
      // If retry logic itself fails, fall through to normal failure handling
    }
  }

  this.emit('task:failed', { taskId, agentId, error: errorMessage });

  await this.db.from('agent_workforce_tasks').update({
    status: 'failed',
    error_message: errorMessage,
    failure_category: failureCategory,
    completed_at: new Date().toISOString(),
    duration_seconds: durationSeconds,
    updated_at: new Date().toISOString(),
  }).eq('id', taskId).then(() => {}, () => {});

  // Reset agent status and increment failed_tasks
  const { data: failedAgent } = await this.db.from('agent_workforce_agents')
    .select('stats').eq('id', agentId).single().then((r) => r, () => ({ data: null }));
  const failedStats = failedAgent
    ? (typeof (failedAgent as { stats: unknown }).stats === 'string'
      ? JSON.parse((failedAgent as { stats: string }).stats)
      : ((failedAgent as { stats: unknown }).stats || {}))
    : {};
  await this.db.from('agent_workforce_agents').update({
    status: 'idle',
    stats: JSON.stringify({
      ...failedStats,
      failed_tasks: (failedStats.failed_tasks || 0) + 1,
    }),
    updated_at: new Date().toISOString(),
  }).eq('id', agentId).then(() => {}, () => {});

  // Report failure to cloud (include state updates if possible)
  const failureReport: import('./types.js').TaskReport = {
    runtimeTaskId: taskId,
    agentId,
    taskTitle: taskTitle || `Task ${taskId}`,
    status: 'failed',
    tokensUsed: 0,
    costCents: 0,
    durationSeconds,
    errorMessage,
    startedAt: new Date(startTime).toISOString(),
    completedAt: new Date().toISOString(),
  };
  if (workspaceId) {
    try {
      const updates = await this.collectStateUpdates(workspaceId, agentId, new Date(startTime).toISOString());
      if (updates.length > 0) {
        failureReport.stateUpdates = updates;
      }
    } catch { /* non-fatal */ }
  }
  this.effects.reportToCloud(failureReport).catch(() => {});

  // Fire-and-forget anomaly detection for failures
  (async () => {
    try {
      const { data: failedAgentRow } = await this.db.from('agent_workforce_agents')
        .select('workspace_id').eq('id', agentId).single();
      const wsId = (failedAgentRow as { workspace_id: string } | null)?.workspace_id;
      if (!wsId) return;
      await detectAndPersistAnomalies({
        db: this.db,
        agentId,
        workspaceId: wsId,
        taskId,
        tokensUsed: 0,
        durationSeconds,
        failed: true,
        toolsUsed: [],
      });
    } catch { /* non-fatal */ }
  })();

  // Fire-and-forget: enrich failure with semantic root-cause classification
  if (this.modelRouter && failureCategory !== 'model_error' && failureCategory !== 'timeout') {
    (async () => {
      try {
        // Read task input from DB since it may not be in scope
        const { data: failedTaskRow } = await this.db.from('agent_workforce_tasks')
          .select('input').eq('id', taskId).single();
        const input = failedTaskRow
          ? String((failedTaskRow as Record<string, unknown>).input ?? '').slice(0, 300)
          : '';
        const rootCause = await classifyRootCause(this.modelRouter!, {
          taskTitle: taskTitle || '',
          taskInput: input,
          errorMessage,
        });
        if (rootCause !== 'unknown') {
          await this.db.from('agent_workforce_tasks')
            .update({ failure_category: rootCause })
            .eq('id', taskId);
        }
      } catch { /* non-fatal enrichment */ }
    })();
  }

  // If Ollama is the only provider and it's down, drain queued tasks immediately
  // instead of letting them each timeout serially
  if (!this.config.anthropicApiKey && this.modelRouter) {
    const isOllamaError = errorMessage.includes('Ollama') ||
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('fetch failed') ||
      errorMessage.includes('Model too large') ||
      errorMessage.includes('Model not found');
    if (isOllamaError) {
      const ollamaUp = await this.modelRouter.isOllamaAvailable().catch(() => false);
      if (!ollamaUp) {
        const drained = this.semaphore.rejectAll(
          new Error('Ollama is not available. Queued tasks cancelled to avoid serial timeouts.'),
        );
        if (drained > 0) {
          logger.warn(`[RuntimeEngine] Drained ${drained} queued task(s) — Ollama unavailable`);
        }
      }
    }
  }

  return {
    success: false,
    taskId,
    status: 'failed',
    error: errorMessage,
    tokensUsed: 0,
    costCents: 0,
  };
}
