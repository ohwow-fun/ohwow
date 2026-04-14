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
import { PermissionDeniedError } from './filesystem/index.js';
import { recordTriggerOutcome } from '../triggers/trigger-watchdog.js';
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

  // FileAccessGuard denials take a different path: the task pauses in
  // needs_approval with a structured permission request for the operator
  // to approve/deny via ohwow_approve_permission_request. Bypasses the
  // retry-with-backoff, status='failed', failed_tasks stats, anomaly
  // detection, root-cause enrichment, and Ollama-drain logic below.
  if (error instanceof PermissionDeniedError) {
    return await handlePermissionDenied.call(this, {
      taskId,
      agentId,
      workspaceId,
      taskTitle,
      details: error.details,
      durationSeconds,
    });
  }

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

  // Trigger watchdog: increment consecutive_failures on the source
  // trigger if any. No-op for operator-dispatched tasks.
  void recordTriggerOutcome(this.db, taskId, 'failure');

  return {
    success: false,
    taskId,
    status: 'failed',
    error: errorMessage,
    tokensUsed: 0,
    costCents: 0,
  };
}

interface HandlePermissionDeniedArgs {
  taskId: string;
  agentId: string;
  workspaceId: string;
  taskTitle: string;
  details: import('./filesystem/permission-error.js').PermissionDeniedDetails;
  durationSeconds: number;
}

async function handlePermissionDenied(
  this: RuntimeEngine,
  args: HandlePermissionDeniedArgs,
): Promise<ExecuteAgentResult> {
  const { taskId, agentId, workspaceId, taskTitle, details, durationSeconds } = args;
  const now = new Date().toISOString();

  // Pull the latest checkpoint iteration (if any) so the permission
  // request payload records where the loop stopped — useful for the
  // operator UI and for any future mid-turn resume implementation.
  let iteration: number | null = null;
  try {
    const { data } = await this.db
      .from('agent_workforce_tasks')
      .select('checkpoint_iteration')
      .eq('id', taskId)
      .single();
    iteration = (data as { checkpoint_iteration: number | null } | null)?.checkpoint_iteration ?? null;
  } catch { /* non-fatal — iteration stays null */ }

  const permissionRequest = {
    tool_name: details.toolName,
    attempted_path: details.attemptedPath,
    suggested_exact: details.suggestedExact,
    suggested_parent: details.suggestedParent,
    guard_reason: details.guardReason,
    iteration,
    timestamp: now,
  };

  await this.db.from('agent_workforce_tasks').update({
    status: 'needs_approval',
    approval_reason: 'permission_denied',
    permission_request: JSON.stringify(permissionRequest),
    duration_seconds: durationSeconds,
    updated_at: now,
  }).eq('id', taskId).then(() => {}, () => {});

  // Reset agent to idle so it can pick up other work while the
  // operator decides. Do NOT bump failed_tasks — this is not a failure.
  await this.db.from('agent_workforce_agents').update({
    status: 'idle',
    updated_at: now,
  }).eq('id', agentId).then(() => {}, () => {});

  // Fetch agent name for the activity + event payload.
  let agentName = 'agent';
  try {
    const { data } = await this.db
      .from('agent_workforce_agents')
      .select('name')
      .eq('id', agentId)
      .single();
    agentName = (data as { name: string } | null)?.name ?? agentName;
  } catch { /* non-fatal */ }

  try {
    await this.db.rpc('create_agent_activity', {
      p_workspace_id: workspaceId,
      p_activity_type: 'permission_requested',
      p_title: `${agentName} wants access to ${details.suggestedExact}`,
      p_description: `${details.toolName}: ${details.guardReason}`,
      p_agent_id: agentId,
      p_task_id: taskId,
      p_metadata: { runtime: true, tool_name: details.toolName },
    });
  } catch { /* non-fatal activity write */ }

  this.emit('task:needs_approval', {
    taskId,
    agentId,
    agentName,
    taskTitle: taskTitle || `Task ${taskId}`,
    workspaceId,
    permission: {
      toolName: details.toolName,
      attemptedPath: details.attemptedPath,
      suggestedExact: details.suggestedExact,
      suggestedParent: details.suggestedParent,
      guardReason: details.guardReason,
    },
  });

  logger.info(
    { taskId, agentId, toolName: details.toolName, attemptedPath: details.attemptedPath },
    '[RuntimeEngine] Task paused on permission request',
  );

  // Trigger watchdog: a paused-for-approval task hasn't succeeded,
  // so count it as a failure. If the operator approves, the resumed
  // child task inherits source_trigger_id and will reset the counter
  // on its own completion.
  void recordTriggerOutcome(this.db, taskId, 'failure');

  return {
    success: false,
    taskId,
    status: 'needs_approval',
    error: `Permission denied: ${details.toolName} on ${details.attemptedPath}`,
    tokensUsed: 0,
    costCents: 0,
  };
}
