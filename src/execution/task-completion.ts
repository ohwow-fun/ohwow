/**
 * Task success completion pipeline — the ~485-LOC block inside
 * RuntimeEngine.executeTask that runs after the ReAct loop finishes
 * successfully: parses the response meta header, computes cost +
 * duration, runs the optional verifier, routes the final status based
 * on autonomy level, writes the task row, persists the ReAct trace,
 * fires output-safety validation and anomaly detection, creates
 * deliverables (tagged + auto-fallback), updates agent stats, bumps
 * goal progress, triggers child tasks, extracts memories, updates
 * session context, and assembles + ships the cloud report.
 *
 * Extracted so executeTask isn't a 1800-LOC method. Uses the
 * `this: RuntimeEngine` pattern so the function can read
 * `this.db`, `this.config`, `this.modelRouter`, `this.anthropic`,
 * `this.effects`, `this.emit`, `this.executeTask` (for child task
 * triggering), and `this.collectStateUpdates`.
 */

import type { RuntimeEngine } from './engine.js';
import type { ExecuteAgentResult } from './types.js';
import { calculateCostCents } from './ai-types.js';
import { upsertDailyResourceUsage } from './budget-guard.js';
import { strengthenSynapse } from '../symbiosis/synapse-dynamics.js';
import {
  isMemorySyncable,
  type ConfidentialityLevel,
  type MemorySyncPolicy,
} from '../lib/memory-utils.js';
import { validateOutputSafety } from '../lib/output-validator.js';
import { verifyAgentOutputLocal } from '../lib/verifier.js';
import { runAgentMemoryMaintenance } from '../lib/memory-maintenance.js';
import { extractMemories as extractMemoriesFromTask } from './memory-sync.js';
import { detectAndPersistAnomalies } from './anomaly-monitoring.js';
import {
  parseResponseMeta,
  shouldAutoCreateDeliverable,
} from './response-classifier.js';
import { logger } from '../lib/logger.js';

/**
 * Shape of a ReAct step entry. Mirrors RuntimeEngine's private
 * `LocalReActStep` interface; duplicated here because it's a narrow
 * record and keeping it inline avoids dragging an `engine.ts` type
 * export into this file's surface.
 */
export interface ReActStep {
  iteration: number;
  thought: string;
  actions: Array<{ tool: string; inputSummary: string }>;
  observations: Array<{ tool: string; resultSummary: string; success: boolean }>;
  durationMs: number;
  timestamp: string;
}

export interface FinalizeTaskSuccessArgs {
  taskId: string;
  agentId: string;
  workspaceId: string;
  task: {
    title: string;
    input: string | unknown;
    parent_task_id: string | null;
    goal_id: string | null;
  };
  agent: {
    name: string;
    stats: string | Record<string, unknown>;
  };
  agentConfig: Record<string, unknown>;
  fullContent: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  reactTrace: ReActStep[];
  providerReportedCostCents: number | undefined;
  useModelRouter: boolean;
  modelId: string;
  startTime: number;
  traceId: string;
  taskInput: string | null;
  autonomyLevel: number;
  approvalRequired: boolean;
  activeSessionId: string | null;
}

export async function finalizeTaskSuccess(
  this: RuntimeEngine,
  args: FinalizeTaskSuccessArgs,
): Promise<ExecuteAgentResult> {
  const {
    taskId, agentId, workspaceId,
    task, agent, agentConfig,
    fullContent, totalInputTokens, totalOutputTokens, reactTrace, providerReportedCostCents,
    useModelRouter, modelId,
    startTime, traceId,
    taskInput,
    autonomyLevel, approvalRequired,
    activeSessionId,
  } = args;

      // Parse response classification
      const { type: responseType, cleanContent } = parseResponseMeta(fullContent);

      const totalTokens = totalInputTokens + totalOutputTokens;
      // Use provider-reported cost (OpenRouter) when available, otherwise estimate
      const costCents = providerReportedCostCents
        ? providerReportedCostCents
        : useModelRouter
        ? 0
        : calculateCostCents(
            'claude-sonnet-4-5',
            totalInputTokens,
            totalOutputTokens,
          );
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);

      // Run verifier check (opt-in, requires Anthropic key)
      let verifierEscalated = false;
      if (
        agentConfig.verifier_enabled === true &&
        this.config.anthropicApiKey &&
        cleanContent.length >= 100
      ) {
        try {
          const taskInputStr = typeof task.input === 'string'
            ? task.input
            : JSON.stringify(task.input ?? '');
          const verification = await verifyAgentOutputLocal(
            taskInputStr,
            cleanContent,
            [], // local engine tool summaries not tracked in this format
            { anthropicApiKey: this.config.anthropicApiKey },
          );
          if (verification && !verification.pass && verification.score < 0.5) {
            verifierEscalated = true;
          }
        } catch { /* non-fatal */ }
      }

      // Autonomy-level-based status routing
      let finalStatus: 'completed' | 'needs_approval' = 'completed';

      // L1 (Observer): All non-informational actions need approval
      if (autonomyLevel === 1) {
        finalStatus = responseType === 'informational' ? 'completed' : 'needs_approval';
      }

      // L2 (Supervised): Deliverable outputs need approval
      if (autonomyLevel <= 2 && responseType === 'deliverable') {
        finalStatus = 'needs_approval';
      }

      // L1-L3: Verifier escalation
      if (autonomyLevel <= 3 && verifierEscalated) {
        finalStatus = 'needs_approval';
      }

      // 7. Save output
      await this.db.from('agent_workforce_tasks').update({
        status: finalStatus,
        output: cleanContent,
        response_type: responseType || null,
        model_used: (agentConfig as Record<string, unknown>)._resolvedModel as string || (useModelRouter ? undefined : modelId),
        tokens_used: totalTokens,
        cost_cents: costCents,
        completed_at: new Date().toISOString(),
        duration_seconds: durationSeconds,
        updated_at: new Date().toISOString(),
      }).eq('id', taskId);

      // Persist ReAct trace in task metadata
      if (reactTrace.length > 0) {
        try {
          const { data: existing } = await this.db
            .from('agent_workforce_tasks')
            .select('metadata')
            .eq('id', taskId)
            .single();
          const existingMetadata = (existing?.metadata as Record<string, unknown>) || {};
          await this.db.from('agent_workforce_tasks').update({
            metadata: JSON.stringify({
              ...existingMetadata,
              react_trace: reactTrace,
            }),
          }).eq('id', taskId);
        } catch { /* non-fatal */ }
      }

      // Fire-and-forget output injection validation
      validateOutputSafety(cleanContent, this.modelRouter).then(async (result) => {
        if (!result.safe) {
          logger.warn(`[RuntimeEngine] Output injection detected for task ${taskId}: ${result.reason}`);
          try {
            const { data: existing } = await this.db
              .from('agent_workforce_tasks')
              .select('metadata')
              .eq('id', taskId)
              .single();
            const existingMetadata = (existing?.metadata as Record<string, unknown>) || {};
            await this.db.from('agent_workforce_tasks').update({
              metadata: JSON.stringify({
                ...existingMetadata,
                output_injection_flagged: true,
                output_injection_reason: result.reason,
              }),
            }).eq('id', taskId);
          } catch { /* non-fatal */ }
        }
      }).catch(() => {});

      // Fire-and-forget anomaly detection (mirrors cloud agent-runner-shared.ts:610-635)
      detectAndPersistAnomalies({
        db: this.db,
        agentId,
        workspaceId,
        taskId,
        tokensUsed: totalTokens,
        durationSeconds,
        failed: false,
        toolsUsed: reactTrace.flatMap(step => step.actions.map(a => a.tool)),
      });

      // Create deliverable record for all deliverable responses
      if (responseType === 'deliverable') {
        try {
          const { data: taskRow } = await this.db
            .from('agent_workforce_tasks')
            .select('deferred_action')
            .eq('id', taskId)
            .single();

          let deferredAction: { type: string; params: Record<string, unknown>; provider: string } | null = null;
          if (taskRow) {
            const raw = (taskRow as Record<string, unknown>).deferred_action;
            deferredAction = raw
              ? (typeof raw === 'string' ? JSON.parse(raw) : raw) as { type: string; params: Record<string, unknown>; provider: string }
              : null;
          }

          const deliverableType = !deferredAction ? 'document'
            : deferredAction.type.toLowerCase().includes('send_email') || deferredAction.type.toLowerCase().includes('gmail') ? 'email'
            : 'other';

          const deliverableTitle = !deferredAction ? task.title
            : deferredAction.params?.to ? `${deferredAction.type.replace(/_/g, ' ')} to ${deferredAction.params.to}`
            : `${deferredAction.type.replace(/_/g, ' ')}: ${task.title}`;

          // Explicit ISO-8601 so list_deliverables' since filter can
          // lexicographically compare against .toISOString() values.
          // Default datetime('now') produces space-separated form that
          // silently loses against ISO filters — bug found in M0.21.
          const deliverableNow = new Date().toISOString();
          await this.db.from('agent_workforce_deliverables').insert({
            workspace_id: workspaceId,
            task_id: taskId,
            agent_id: agentId,
            deliverable_type: deliverableType,
            provider: deferredAction?.provider || null,
            title: deliverableTitle,
            content: JSON.stringify(deferredAction?.params || { text: cleanContent }),
            status: finalStatus === 'needs_approval' ? 'pending_review' : 'approved',
            auto_created: 0,
            created_at: deliverableNow,
            updated_at: deliverableNow,
          });
        } catch (err) {
          logger.error({ err }, '[RuntimeEngine] Deliverable creation failed');
        }
      }

      // Auto-deliverable fallback: if agent didn't tag but output is substantial
      if (!responseType && cleanContent) {
        try {
          const { data: taskMeta } = await this.db
            .from('agent_workforce_tasks')
            .select('source_type')
            .eq('id', taskId)
            .single();
          const sourceType = (taskMeta as Record<string, unknown> | null)?.source_type as string | null;
          const auto = shouldAutoCreateDeliverable(cleanContent, {
            title: task.title,
            sourceType,
          });
          if (auto.create) {
            // Explicit ISO-8601 to match list_deliverables' since-filter
            // comparator — see comment on the explicit-create path above.
            const autoNow = new Date().toISOString();
            await this.db.from('agent_workforce_deliverables').insert({
              workspace_id: workspaceId,
              task_id: taskId,
              agent_id: agentId,
              deliverable_type: auto.inferredType,
              title: task.title,
              content: JSON.stringify({ text: cleanContent }),
              status: finalStatus === 'needs_approval' ? 'pending_review' : 'approved',
              auto_created: 1,
              created_at: autoNow,
              updated_at: autoNow,
            });
          }
        } catch (err) {
          logger.error({ err }, '[RuntimeEngine] Auto-deliverable fallback failed');
        }
      }

      // Save assistant message
      await this.db.from('agent_workforce_task_messages').insert({
        task_id: taskId,
        role: 'assistant',
        content: cleanContent,
        metadata: JSON.stringify({ tokensUsed: totalTokens }),
      });

      // Update agent stats with running averages
      const currentStats = typeof agent.stats === 'string' ? JSON.parse(agent.stats) : (agent.stats || {});
      const newTotal = (currentStats.total_tasks || 0) + 1;
      const prevAvgDuration = currentStats.avg_duration_seconds || 0;
      const prevAvgTokens = currentStats.avg_tokens || 0;
      await this.db.from('agent_workforce_agents').update({
        status: 'idle',
        stats: JSON.stringify({
          total_tasks: newTotal,
          completed_tasks: (currentStats.completed_tasks || 0) + (finalStatus === 'completed' ? 1 : 0),
          failed_tasks: currentStats.failed_tasks || 0,
          tokens_used: (currentStats.tokens_used || 0) + totalTokens,
          cost_cents: (currentStats.cost_cents || 0) + costCents,
          avg_duration_seconds: Math.round(prevAvgDuration + (durationSeconds - prevAvgDuration) / newTotal),
          avg_tokens: Math.round(prevAvgTokens + (totalTokens - prevAvgTokens) / newTotal),
          last_task_at: new Date().toISOString(),
        }),
        updated_at: new Date().toISOString(),
      }).eq('id', agentId);

      // Track daily resource usage (for budget guard queries)
      void upsertDailyResourceUsage(this.db, workspaceId, totalTokens, costCents);

      // Auto-strengthen delegation synapses when a subtask completes for a different agent
      if (task.parent_task_id) {
        try {
          const { data: parentTask } = await this.db
            .from('agent_workforce_tasks')
            .select('agent_id')
            .eq('id', task.parent_task_id)
            .maybeSingle();
          const parentAgentId = (parentTask as { agent_id: string } | null)?.agent_id;
          if (parentAgentId && parentAgentId !== agentId) {
            void strengthenSynapse(this.db, workspaceId, parentAgentId, agentId, 'delegation', {
              type: 'task_delegation',
              detail: `Task "${task.title}" delegated from parent task ${task.parent_task_id}`,
              timestamp: new Date().toISOString(),
            });
          }
        } catch { /* non-fatal synapse tracking */ }
      }

      // Log activity
      await this.db.rpc('create_agent_activity', {
        p_workspace_id: workspaceId,
        p_activity_type: 'task_completed',
        p_title: `${task.title} — ${finalStatus}`,
        p_description: `${totalTokens} tokens, ${durationSeconds}s`,
        p_agent_id: agentId,
        p_task_id: taskId,
        p_metadata: { runtime: true },
      });

      if (finalStatus === 'needs_approval') {
        this.emit('task:needs_approval', {
          taskId,
          agentId,
          agentName: agent.name,
          taskTitle: task.title,
          deliverableType: approvalRequired && responseType === 'deliverable' ? 'deliverable' : undefined,
          workspaceId,
        });
      }

      this.emit('task:completed', { taskId, agentId, status: finalStatus, tokensUsed: totalTokens, costCents });

      // 7.5 Auto-increment goal progress on successful completion
      // Skip auto-increment if agent explicitly called update_goal_progress
      const agentSetGoalManually = reactTrace.some(step =>
        step.actions.some(a => a.tool === 'update_goal_progress'),
      );
      if (task.goal_id && finalStatus === 'completed' && !agentSetGoalManually) {
        try {
          const { data: goalData } = await this.db
            .from('agent_workforce_goals')
            .select('current_value, target_value, status')
            .eq('id', task.goal_id)
            .single();

          if (goalData) {
            const goal = goalData as { current_value: number | null; target_value: number | null; status: string };
            const newValue = (goal.current_value ?? 0) + 1;
            const updateData: Record<string, unknown> = {
              current_value: newValue,
              updated_at: new Date().toISOString(),
            };
            // Auto-complete goal if target reached
            if (goal.target_value && newValue >= goal.target_value && goal.status === 'active') {
              updateData.status = 'completed';
              updateData.completed_at = new Date().toISOString();
            }
            await this.db
              .from('agent_workforce_goals')
              .update(updateData)
              .eq('id', task.goal_id);
          }
        } catch {
          logger.warn('[RuntimeEngine] Goal progress update skipped');
        }
      }

      // 7.6 Trigger pending child tasks (dependency chain)
      if (finalStatus === 'completed') {
        (async () => {
          try {
            const { data: childTasks } = await this.db
              .from('agent_workforce_tasks')
              .select('id, agent_id')
              .eq('parent_task_id', taskId)
              .eq('status', 'pending');
            if (childTasks && (childTasks as unknown[]).length > 0) {
              for (const child of childTasks as Array<{ id: string; agent_id: string }>) {
                logger.info(`[RuntimeEngine] Triggering child task ${child.id} after parent ${taskId} completed`);
                this.executeTask(child.agent_id, child.id).catch(err => {
                  logger.error({ err }, `[RuntimeEngine] Child task ${child.id} execution failed`);
                });
              }
            }
          } catch {
            logger.warn('[RuntimeEngine] Child task triggering skipped');
          }
        })();
      }

      // 8. Extract memories and include in task report if sync is enabled
      const toolsUsedInTask = reactTrace.flatMap(step => step.actions.map(a => a.tool));
      extractMemoriesFromTask(
        { agentId, taskId, workspaceId, taskTitle: task.title, taskInput: taskInput || '', taskOutput: cleanContent, toolsUsed: toolsUsedInTask },
        { db: this.db, anthropic: this.anthropic, modelRouter: this.modelRouter, onMemoryExtracted: (aid, count) => this.emit('memory:extracted', { agentId: aid, count }) },
      )
        .then(async (extractedMemories) => {
          // Check if memory sync is enabled and agent has a sync policy
          if (extractedMemories.length > 0) {
            try {
              const { data: syncSetting } = await this.db
                .from('runtime_settings')
                .select('value')
                .eq('key', 'memory_sync_enabled')
                .maybeSingle();

              const syncEnabled = syncSetting && (syncSetting as { value: string }).value === 'true';

              // Get the agent's sync policy
              const { data: agentSyncData } = await this.db
                .from('agent_workforce_agents')
                .select('memory_sync_policy')
                .eq('id', agentId)
                .single();

              const agentSyncPolicy = ((agentSyncData as Record<string, unknown> | null)?.memory_sync_policy as MemorySyncPolicy) || 'none';

              if (syncEnabled && agentSyncPolicy !== 'none') {
                // Filter memories by sync policy
                const syncableMemories = extractedMemories.filter(m =>
                  isMemorySyncable(
                    {
                      memoryType: m.memoryType,
                      confidentialityLevel: m.confidentialityLevel as ConfidentialityLevel,
                      isLocalOnly: false,
                    },
                    agentSyncPolicy,
                  ),
                );

                if (syncableMemories.length > 0) {
                  // Send memories with the task report
                  this.effects.reportToCloud({
                    runtimeTaskId: taskId,
                    agentId,
                    taskTitle: task.title,
                    status: 'memory_sync',
                    tokensUsed: 0,
                    costCents: 0,
                    memories: { extracted: syncableMemories },
                  }).catch(() => {});
                }
              }
            } catch { /* non-fatal */ }
          }
        })
        .catch(err => {
          logger.error({ err }, '[RuntimeEngine] Memory extraction failed');
        });

      // Auto-trigger memory maintenance every 10 tasks
      if (newTotal % 10 === 0) {
        (async () => {
          try {
            await runAgentMemoryMaintenance(this.db, workspaceId, {
              agentId,
              anthropicApiKey: this.config.anthropicApiKey || undefined,
            });
          } catch { /* non-fatal */ }
        })();
      }

      // 8.1 Update session context (async, don't block)
      if (activeSessionId) {
        (async () => {
          try {
            const { data: session } = await this.db
              .from('agent_workforce_sessions')
              .select('context_summary')
              .eq('id', activeSessionId)
              .single();

            const existingContext = (session?.context_summary as string) || '';
            const taskSummary = `Task "${task.title}": ${cleanContent.slice(0, 200)}`;
            const newContext = existingContext
              ? `${existingContext}\n\n${taskSummary}`
              : taskSummary;

            const SESSION_TIMEOUT_HOURS = 4;
            await this.db
              .from('agent_workforce_sessions')
              .update({
                context_summary: newContext.slice(0, 4000),
                last_active_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + SESSION_TIMEOUT_HOURS * 3600000).toISOString(),
              })
              .eq('id', activeSessionId);
          } catch {
            logger.warn('[RuntimeEngine] Session context update skipped');
          }
        })();
      }

      // 9. Report to cloud (async, don't block)
      // Collect state updates made during this task for cloud sync
      const cloudReport: import('./types.js').TaskReport = {
        runtimeTaskId: taskId,
        agentId,
        taskTitle: task.title,
        status: finalStatus,
        tokensUsed: totalTokens,
        costCents,
        durationSeconds,
        modelUsed: (agentConfig as Record<string, unknown>)._resolvedModel as string | undefined,
        startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(),
        taskOutput: cleanContent || undefined,
        reactTrace: reactTrace.length > 0 ? reactTrace : undefined,
      };

      // Include state updates modified during this task execution
      try {
        const updates = await this.collectStateUpdates(workspaceId, agentId, new Date(startTime).toISOString());
        if (updates.length > 0) {
          cloudReport.stateUpdates = updates;
        }
      } catch { /* non-fatal */ }

      // Include goal progress if applicable
      if (task.goal_id && finalStatus === 'completed') {
        try {
          const { data: goalRow } = await this.db
            .from('agent_workforce_goals')
            .select('current_value, status')
            .eq('id', task.goal_id)
            .single();
          if (goalRow) {
            const g = goalRow as { current_value: number; status: string };
            cloudReport.goalProgress = {
              goalId: task.goal_id,
              newValue: g.current_value,
              completed: g.status === 'completed',
            };
          }
        } catch { /* non-fatal */ }
      }

      this.effects.reportToCloud(cloudReport).catch(err => {
        logger.error({ err }, '[RuntimeEngine] Cloud report failed');
      });

      return {
        success: true,
        taskId,
        status: finalStatus,
        output: cleanContent,
        tokensUsed: totalTokens,
        costCents,
        responseType: responseType || undefined,
        traceId,
      };
}
