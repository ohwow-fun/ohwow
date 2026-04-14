/**
 * Trigger watchdog — aggregates per-task outcomes into trigger-level
 * "is this scheduled thing still succeeding?" signal.
 *
 * Background
 * ----------
 * Before experiment E2, a scheduled trigger could fire every night,
 * every task could fail the hallucination gate, and nothing at the
 * trigger level knew. last_fired_at recorded "a firing happened";
 * nothing recorded "a firing succeeded" or "this trigger has been
 * broken for N consecutive runs." The diary trigger silently failed
 * for 2+ weeks because of exactly this blind spot — the failure was
 * only caught when someone happened to read a task output.
 *
 * What this does
 * --------------
 * `recordTriggerOutcome(db, taskId, outcome)` is called from every
 * task-finalization path (finalizeTaskSuccess, handleTaskFailure,
 * handlePermissionDenied). It:
 *   1. Looks up the task's source_trigger_id — no-op if the task
 *      wasn't spawned by a trigger (operator-dispatched tasks, child
 *      tasks from approvals that aren't themselves trigger-linked).
 *   2. On 'success': resets consecutive_failures to 0 and stamps
 *      last_succeeded_at. The trigger is healthy again.
 *   3. On 'failure': increments consecutive_failures by 1. If the
 *      new count crosses STUCK_THRESHOLD for the first time, writes
 *      an agent_workforce_activities row with
 *      activity_type='trigger_stuck' so the operator's existing
 *      activity surface picks it up without new UI.
 *
 * Errors are swallowed — a watchdog failure must never break task
 * finalization. The helper logs and returns.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

/**
 * Number of consecutive failures that trips the "stuck" alert. Picked
 * by hand: 1 is too jumpy (a single transient failure shouldn't page
 * anyone), 5+ lets the diary trigger fail half a week before anyone
 * notices. 3 means the first stuck alert fires on night 3 of a
 * silently-miscarrying nightly cron — acceptable lag for a daemon
 * that has no push-alert channel today.
 */
export const TRIGGER_STUCK_THRESHOLD = 3;

export type TriggerOutcome = 'success' | 'failure';

/**
 * Record a task outcome against its source trigger, if any.
 *
 * Safe to call for every task: tasks without a source_trigger_id
 * are silently skipped. Tasks that trace back to a deleted trigger
 * log a debug line and skip. Any DB error is swallowed and logged.
 */
export async function recordTriggerOutcome(
  db: DatabaseAdapter,
  taskId: string,
  outcome: TriggerOutcome,
): Promise<void> {
  try {
    const { data: taskRow } = await db
      .from<{ source_trigger_id: string | null; workspace_id: string; agent_id: string }>('agent_workforce_tasks')
      .select('source_trigger_id, workspace_id, agent_id')
      .eq('id', taskId)
      .single();

    if (!taskRow) return;
    const triggerId = (taskRow as { source_trigger_id: string | null }).source_trigger_id;
    if (!triggerId) return;
    const workspaceId = (taskRow as { workspace_id: string }).workspace_id;
    const agentId = (taskRow as { agent_id: string }).agent_id;

    const now = new Date().toISOString();

    if (outcome === 'success') {
      await db.from('local_triggers').update({
        last_succeeded_at: now,
        consecutive_failures: 0,
        updated_at: now,
      }).eq('id', triggerId);
      return;
    }

    // Failure path — read current count, increment, write back.
    // Two-phase because SQLite via the adapter doesn't support
    // atomic arithmetic updates. Race between two concurrent failures
    // of the same trigger would lose one increment, which is fine for
    // a watchdog threshold (worst case: alert fires one run late).
    const { data: triggerRow } = await db
      .from<{ name: string; consecutive_failures: number | null }>('local_triggers')
      .select('name, consecutive_failures')
      .eq('id', triggerId)
      .single();

    if (!triggerRow) {
      // Trigger was deleted between task spawn and finalize — nothing to update.
      logger.debug({ taskId, triggerId }, '[trigger-watchdog] trigger not found, skipping');
      return;
    }

    const row = triggerRow as { name: string; consecutive_failures: number | null };
    const prev = row.consecutive_failures ?? 0;
    const next = prev + 1;

    await db.from('local_triggers').update({
      consecutive_failures: next,
      updated_at: now,
    }).eq('id', triggerId);

    // Only emit the stuck alert on the exact firing that crosses the
    // threshold. Subsequent failures keep incrementing silently so the
    // activity log doesn't spam. The counter reset on next success will
    // re-arm the alert for the next stuck episode.
    if (prev < TRIGGER_STUCK_THRESHOLD && next >= TRIGGER_STUCK_THRESHOLD) {
      try {
        await db.rpc('create_agent_activity', {
          p_workspace_id: workspaceId,
          p_activity_type: 'trigger_stuck',
          p_title: `Trigger "${row.name}" has failed ${next} runs in a row`,
          p_description: `Silent-failure watchdog: no successful completion on a row that traces back to trigger ${triggerId}. Check ohwow_list_failing_triggers for details.`,
          p_agent_id: agentId,
          p_task_id: taskId,
          p_metadata: {
            runtime: true,
            trigger_id: triggerId,
            consecutive_failures: next,
          },
        });
      } catch { /* non-fatal activity write */ }
      logger.warn(
        { triggerId, triggerName: row.name, consecutive_failures: next },
        '[trigger-watchdog] trigger crossed stuck threshold',
      );
    }
  } catch (err) {
    logger.warn({ err, taskId, outcome }, '[trigger-watchdog] failed to record outcome');
  }
}
