/**
 * StaleTaskCleanupExperiment — first Phase 2 experiment that
 * actually mutates system state.
 *
 * Why this exists
 * ---------------
 * Tasks in status='in_progress' with no updated_at change in the
 * last STALE_THRESHOLD_MS are zombies: the execution path died, the
 * daemon restarted mid-run, a provider network hang was never
 * surfaced, or a hallucination gate throw was swallowed before
 * reaching handleTaskFailure. Today they sit in in_progress
 * forever, their agents stay locked in 'working' status, and
 * operators have to manually SQL-update them to recover.
 *
 * This experiment sweeps them on a 5-minute tick. Probe finds any
 * in_progress row whose updated_at is older than the threshold,
 * judge returns warning when zombies exist, intervene marks them
 * failed with failure_category='stale_abandoned' and resets their
 * agents to idle. The intervention is load-bearing: it's the first
 * experiment in the loop that actually changes state based on a
 * judge verdict, and therefore the first one that needs to be
 * defensive about what it touches.
 *
 * Safety rails
 * ------------
 * - Only touches tasks with updated_at older than threshold AND
 *   started_at older than threshold (both must be stale, so a
 *   freshly-spawned task that hasn't checkpointed yet is not
 *   eligible).
 * - Does NOT touch tasks with status other than in_progress —
 *   pending, paused, needs_approval, failed, completed are all
 *   already in terminal or actionable states and don't need sweep.
 * - Does NOT touch the task's response_type, deliverable rows,
 *   or checkpoint — only status + error_message + failure_category
 *   + completed_at + duration_seconds.
 * - Resets each affected agent to idle so the next scheduler tick
 *   can assign new work to it.
 * - Every intervention lands a structured finding with the task ids
 *   so the cleanup is reversible by reading the ledger.
 *
 * Threshold tuning
 * ----------------
 * 10 minutes is conservative. The longest real-world legitimate
 * ohwow task run I've seen is ~6 minutes (the self-diary trigger
 * with 5 sqlite queries + compose + write). 10m gives 1.5x
 * headroom on that. Tasks that legitimately take longer should set
 * max_duration_seconds explicitly — when that column starts being
 * enforced elsewhere, the sweeper can read it and widen the
 * per-task threshold.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

/** Tasks with updated_at older than this are considered abandoned. */
const STALE_THRESHOLD_MS = 10 * 60 * 1000;

interface StaleTaskRow {
  id: string;
  agent_id: string;
  title: string;
  started_at: string | null;
  updated_at: string;
  status: string;
}

interface StaleCleanupEvidence extends Record<string, unknown> {
  stale_tasks: Array<{
    task_id: string;
    agent_id: string;
    title: string;
    started_at: string | null;
    updated_at: string;
    stale_for_ms: number;
  }>;
  stale_count: number;
  stale_threshold_ms: number;
  stale_cutoff_iso: string;
}

export class StaleTaskCleanupExperiment implements Experiment {
  id = 'stale-task-cleanup';
  name = 'Zombie in_progress task sweeper';
  category = 'other' as const;
  hypothesis =
    'Tasks in status=in_progress with no updated_at change in STALE_THRESHOLD_MS have been abandoned by a dead execution path — their execution will never resume, their agents stay locked, and they should be marked failed to unblock the queue.';
  cadence = { everyMs: 5 * 60 * 1000, runOnBoot: false };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const now = Date.now();
    const cutoffIso = new Date(now - STALE_THRESHOLD_MS).toISOString();

    const { data } = await ctx.db
      .from<StaleTaskRow>('agent_workforce_tasks')
      .select('id, agent_id, title, started_at, updated_at, status')
      .eq('status', 'in_progress')
      .lt('updated_at', cutoffIso);

    const rows = (data ?? []) as StaleTaskRow[];
    const stale = rows
      .filter((r) => !r.started_at || r.started_at < cutoffIso)
      .map((r) => ({
        task_id: r.id,
        agent_id: r.agent_id,
        title: r.title,
        started_at: r.started_at,
        updated_at: r.updated_at,
        stale_for_ms: now - new Date(r.updated_at).getTime(),
      }));

    const evidence: StaleCleanupEvidence = {
      stale_tasks: stale,
      stale_count: stale.length,
      stale_threshold_ms: STALE_THRESHOLD_MS,
      stale_cutoff_iso: cutoffIso,
    };

    const summary = stale.length === 0
      ? 'no stale in_progress tasks'
      : `${stale.length} stale in_progress task(s) awaiting cleanup`;

    const subject = stale.length > 0 ? `task:${stale[0].task_id}` : null;
    return { subject, summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as StaleCleanupEvidence;
    if (ev.stale_count === 0) return 'pass';
    // Any stale task is a warning, not a fail. The system is
    // self-healing — the intervene step will clean them up. A fail
    // verdict is reserved for things the system can't fix without
    // operator help.
    return 'warning';
  }

  async intervene(
    _verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const ev = result.evidence as StaleCleanupEvidence;
    if (ev.stale_count === 0) return null;

    const now = new Date().toISOString();
    const cleanedTaskIds: string[] = [];
    const affectedAgentIds = new Set<string>();

    for (const task of ev.stale_tasks) {
      try {
        await ctx.db.from('agent_workforce_tasks').update({
          status: 'failed',
          error_message: `Stale in_progress task swept by stale-task-cleanup experiment — updated_at was ${Math.round(task.stale_for_ms / 1000)}s old`,
          failure_category: 'stale_abandoned',
          completed_at: now,
          duration_seconds: Math.round(task.stale_for_ms / 1000),
          updated_at: now,
        }).eq('id', task.task_id);
        cleanedTaskIds.push(task.task_id);
        affectedAgentIds.add(task.agent_id);
      } catch (err) {
        // Non-fatal per task — the next tick will pick up anything
        // we couldn't update here. Don't let one bad row stop the
        // rest of the sweep.
        // eslint-disable-next-line no-console
      }
    }

    // Reset affected agents to idle so the scheduler can assign them
    // new work on the next tick.
    for (const agentId of affectedAgentIds) {
      try {
        await ctx.db.from('agent_workforce_agents').update({
          status: 'idle',
          updated_at: now,
        }).eq('id', agentId);
      } catch { /* best effort */ }
    }

    return {
      description: `Swept ${cleanedTaskIds.length} stale in_progress task(s) → failed, reset ${affectedAgentIds.size} agent(s) to idle`,
      details: {
        cleaned_task_ids: cleanedTaskIds,
        affected_agent_ids: Array.from(affectedAgentIds),
        stale_threshold_ms: ev.stale_threshold_ms,
      },
    };
  }
}
