/**
 * ContentCadenceLoopHealthExperiment — meta-watcher over the
 * content-cadence closed loop.
 *
 * Why this exists
 * ---------------
 * The content-cadence loop has many moving parts — ContentCadenceScheduler
 * dispatches post tasks hourly, agents execute them via the X-posting tools,
 * the goal-x-posts-per-week row's current_value gets updated from the
 * trailing-7d post count, and ContentCadenceTunerExperiment reads that
 * goal every 6 hours and decides whether to widen content_cadence.posts_per_day.
 *
 * Each link in that chain can break silently. Three real bugs already
 * shipped in this loop without anyone noticing for hours:
 *   - scheduler queried status='active' for agents (never matches; lifecycle
 *     is {idle, working})
 *   - scheduler queried tasks.ended_at (column doesn't exist; the
 *     surrounding try/catch swallowed the SqliteError and returned 0)
 *   - goal seed used target=7 over 90 days, collapsing required velocity
 *     to 0.078/day so the tuner permanently judged 'pass'
 *
 * No infrastructure experiment caught any of them. The runtime appeared
 * healthy — model-health passed, trigger-stability passed, agent-outcomes
 * said "no agents currently working" (correctly, because no work was
 * flowing) — but the business outcome was zero posts forever.
 *
 * This experiment is the dedicated probe for "is the closed loop actually
 * closing." It checks the vital signs that, together, prove a cycle has
 * recently completed end-to-end:
 *
 *   1. Goal row exists and its updated_at moved in the last 2 hours
 *      (scheduler is alive and ticking)
 *   2. At least one post task was dispatched in the last 24 hours
 *      (dispatcher is finding agents and inserting work)
 *   3. Dispatched tasks have a sane completion ratio
 *      (agents are taking the work and finishing it)
 *   4. The tuner has emitted at least one finding in the last 24 hours
 *      (tuner cadence is firing on schedule)
 *   5. If the tuner's knob is set in runtime_config_overrides, a matching
 *      validation row exists in experiment_validations
 *      (intervention → validation chain is intact)
 *
 * Severity
 * --------
 *   pass     all vital signs OK, OR loop is brand new (<24h since goal
 *            seeded) and we don't have enough data to judge
 *   warning  1-2 vital signs broken — degraded loop, operator should look
 *   fail     3+ vital signs broken OR scheduler hasn't ticked in 6h+
 *
 * No intervene
 * ------------
 * This experiment exists to make hidden failure visible, not to auto-heal.
 * The fixes for the scheduler bugs were 1-line code changes; the runtime
 * can't generate those autonomously. The probe's job is to fire the
 * warning loudly enough that the next operator (or a future authoring
 * loop) reads the evidence and ships a fix.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { BusinessExperiment } from '../business-experiment.js';
import {
  CONTENT_CADENCE_CONFIG_KEY,
  CONTENT_CADENCE_GOAL_METRIC,
} from './content-cadence-tuner.js';
import type {
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

/** Title the scheduler uses for dispatched post tasks. Used to count dispatches. */
const SCHEDULER_TASK_TITLE = 'Post one tweet today';

/** Tuner experiment id whose findings + validations we read. */
const TUNER_EXPERIMENT_ID = 'content-cadence-tuner';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long the goal must have existed before we apply severity rules. */
const WARMUP_MS = 24 * HOUR_MS;

/** scheduler.tick is hourly — flag if updated_at hasn't moved in 2x cadence. */
const SCHEDULER_STALE_WARN_MS = 2 * HOUR_MS;

/** Scheduler-died fail threshold. */
const SCHEDULER_DEAD_FAIL_MS = 6 * HOUR_MS;

interface VitalSigns {
  scheduler_alive: boolean;
  dispatcher_active: boolean;
  posts_completing: boolean;
  tuner_alive: boolean;
  validation_chain_intact: boolean;
}

interface LoopHealthEvidence extends Record<string, unknown> {
  goal_exists: boolean;
  loop_age_hours?: number;
  scheduler_idle_hours?: number;
  scheduler_dispatches_24h: number;
  posts_completed_24h: number;
  posts_completed_7d: number;
  tuner_findings_24h: number;
  tuner_interventions_24h: number;
  tuner_pending_validations: number;
  knob_value?: number | null;
  vital_signs: VitalSigns;
  failures: string[];
  reason?: string;
}

interface GoalRow {
  id: string;
  current_value: number | null;
  target_value: number | null;
  updated_at: string | null;
  created_at: string | null;
}

interface TaskRow {
  id: string;
  title: string | null;
  status: string;
  metadata: string | null;
  created_at: string | null;
  completed_at: string | null;
}

interface OverrideRow {
  key: string;
  value: string | null;
  set_at: string | null;
}

interface ValidationRow {
  id: string;
  experiment_id: string;
  status: string;
  validate_at: string;
  created_at: string | null;
}

export class ContentCadenceLoopHealthExperiment extends BusinessExperiment {
  id = 'content-cadence-loop-health';
  name = 'Content cadence loop health watcher';
  hypothesis =
    'The end-to-end content-cadence loop (scheduler → dispatch → agent → ' +
    'goal update → tuner → validation) completes at least one cycle per 24h. ' +
    'Reading scheduler ticks, post task counts, tuner findings, and validation ' +
    'chain integrity catches any single broken link before the loop dies silently.';
  cadence = {
    everyMs: HOUR_MS,
    runOnBoot: true,
  };

  protected async businessProbe(ctx: ExperimentContext): Promise<ProbeResult> {
    const goal = await this.readGoal(ctx.db, ctx.workspaceId);

    if (!goal) {
      // Scheduler hasn't booted yet (or hasn't reached its first tick).
      // Pass — there is nothing to monitor. The scheduler's own boot log
      // is the right surface for "did the scheduler start" rather than
      // this watcher.
      const evidence: LoopHealthEvidence = {
        goal_exists: false,
        scheduler_dispatches_24h: 0,
        posts_completed_24h: 0,
        posts_completed_7d: 0,
        tuner_findings_24h: 0,
        tuner_interventions_24h: 0,
        tuner_pending_validations: 0,
        vital_signs: blankVitalSigns(),
        failures: [],
        reason: 'no_goal_yet',
      };
      return {
        subject: null,
        summary:
          `no '${CONTENT_CADENCE_GOAL_METRIC}' goal yet — scheduler may not have booted, nothing to watch`,
        evidence,
      };
    }

    const now = Date.now();
    const goalCreatedMs = goal.created_at ? new Date(goal.created_at).getTime() : now;
    const loopAgeMs = now - goalCreatedMs;
    const goalUpdatedMs = goal.updated_at ? new Date(goal.updated_at).getTime() : 0;
    const schedulerIdleMs = goalUpdatedMs > 0 ? now - goalUpdatedMs : Infinity;

    const since24h = new Date(now - DAY_MS).toISOString();
    const since7d = new Date(now - 7 * DAY_MS).toISOString();

    const tasks = await this.readWorkspaceTasks(ctx.db, ctx.workspaceId, since7d);
    const dispatches24h = tasks.filter(
      (t) => t.title === SCHEDULER_TASK_TITLE && (t.created_at ?? '') >= since24h,
    ).length;
    const completed24h = tasks.filter((t) => isCompletedXPost(t, since24h)).length;
    const completed7d = tasks.filter((t) => isCompletedXPost(t, since7d)).length;

    const tunerHistory = await ctx.recentFindings(TUNER_EXPERIMENT_ID, 50);
    const tunerFindings24h = tunerHistory.filter((f) => f.ranAt >= since24h).length;
    const tunerInterventions24h = tunerHistory.filter(
      (f) => f.ranAt >= since24h && f.interventionApplied !== null,
    ).length;

    const knobValue = await this.readKnob(ctx.db);
    const tunerPendingValidations = await this.readPendingValidationCount(
      ctx.db,
      TUNER_EXPERIMENT_ID,
    );

    const vitals: VitalSigns = {
      scheduler_alive: schedulerIdleMs <= SCHEDULER_STALE_WARN_MS,
      // "Dispatcher active" is true if the scheduler dispatched OR the budget
      // was already met for the day — both are non-failure outcomes. We
      // approximate "budget met" as "completed posts today >= 1," which is
      // good enough for the v1 vital sign without re-reading the knob.
      dispatcher_active: dispatches24h > 0 || completed24h > 0,
      // If we dispatched but nothing completed, agents aren't taking the work.
      // Skip this check entirely when no dispatches happened (no signal to judge).
      posts_completing: dispatches24h === 0 || completed24h > 0,
      tuner_alive: tunerFindings24h > 0,
      // If tuner intervened (knob set), there must be a validation row for it.
      // When knob is null, this check trivially passes.
      validation_chain_intact:
        knobValue === null ||
        tunerInterventions24h === 0 ||
        tunerPendingValidations > 0,
    };

    const failures = collectFailures(vitals);

    const evidence: LoopHealthEvidence = {
      goal_exists: true,
      loop_age_hours: Math.round((loopAgeMs / HOUR_MS) * 10) / 10,
      scheduler_idle_hours: Number.isFinite(schedulerIdleMs)
        ? Math.round((schedulerIdleMs / HOUR_MS) * 10) / 10
        : null as unknown as number,
      scheduler_dispatches_24h: dispatches24h,
      posts_completed_24h: completed24h,
      posts_completed_7d: completed7d,
      tuner_findings_24h: tunerFindings24h,
      tuner_interventions_24h: tunerInterventions24h,
      tuner_pending_validations: tunerPendingValidations,
      knob_value: knobValue,
      vital_signs: vitals,
      failures,
    };

    if (loopAgeMs < WARMUP_MS) {
      // Loop is brand new — the operator just stood it up. Don't fire
      // false alarms before there's been enough time to expect a full
      // cycle. Surface the evidence with reason='warmup' so the ledger
      // still shows what we observed.
      evidence.reason = 'warmup';
      return {
        subject: `loop:${goal.id}`,
        summary: `loop is ${evidence.loop_age_hours}h old (warmup window 24h) — observing without judging`,
        evidence,
      };
    }

    const summary = failures.length === 0
      ? `loop healthy: ${dispatches24h} dispatches/24h, ${completed24h} posts/24h, ${tunerFindings24h} tuner ticks/24h`
      : `loop degraded: ${failures.join('; ')}`;

    return {
      subject: `loop:${goal.id}`,
      summary,
      evidence,
    };
  }

  protected businessJudge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as LoopHealthEvidence;
    if (ev.reason === 'no_goal_yet' || ev.reason === 'warmup') return 'pass';

    const idleMs = (ev.scheduler_idle_hours ?? 0) * HOUR_MS;
    if (idleMs >= SCHEDULER_DEAD_FAIL_MS) return 'fail';

    const failureCount = ev.failures.length;
    if (failureCount >= 3) return 'fail';
    if (failureCount >= 1) return 'warning';
    return 'pass';
  }

  // No businessIntervene override — pure observer. The fixes for the
  // failure modes this watcher detects are code changes, not runtime
  // mutations. Surfacing the warning IS the action.

  private async readGoal(
    db: DatabaseAdapter,
    workspaceId: string,
  ): Promise<GoalRow | null> {
    try {
      const { data } = await db
        .from<GoalRow>('agent_workforce_goals')
        .select('id, current_value, target_value, updated_at, created_at')
        .eq('workspace_id', workspaceId)
        .eq('target_metric', CONTENT_CADENCE_GOAL_METRIC)
        .eq('status', 'active');
      const rows = (data ?? []) as GoalRow[];
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  private async readWorkspaceTasks(
    db: DatabaseAdapter,
    workspaceId: string,
    since: string,
  ): Promise<TaskRow[]> {
    try {
      const { data } = await db
        .from<TaskRow>('agent_workforce_tasks')
        .select('id, title, status, metadata, created_at, completed_at')
        .eq('workspace_id', workspaceId);
      const rows = (data ?? []) as TaskRow[];
      // Trailing-7d window applied in JS (no .gte on the adapter for this
      // workspace consistently). created_at OR completed_at within the
      // window — the consumer slices further.
      return rows.filter(
        (t) =>
          (t.created_at ?? '') >= since || (t.completed_at ?? '') >= since,
      );
    } catch {
      return [];
    }
  }

  private async readKnob(db: DatabaseAdapter): Promise<number | null> {
    try {
      const { data } = await db
        .from<OverrideRow>('runtime_config_overrides')
        .select('key, value, set_at')
        .eq('key', CONTENT_CADENCE_CONFIG_KEY);
      const rows = (data ?? []) as OverrideRow[];
      const row = rows[0];
      if (!row || row.value == null) return null;
      const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      return typeof parsed === 'number' ? parsed : null;
    } catch {
      return null;
    }
  }

  private async readPendingValidationCount(
    db: DatabaseAdapter,
    experimentId: string,
  ): Promise<number> {
    try {
      const { data } = await db
        .from<ValidationRow>('experiment_validations')
        .select('id, experiment_id, status, validate_at, created_at')
        .eq('experiment_id', experimentId);
      const rows = (data ?? []) as ValidationRow[];
      // Pending OR completed in the last 24h both count as "intact" — a
      // recently-completed validation is the same signal as a pending one.
      const cutoff = new Date(Date.now() - DAY_MS).toISOString();
      return rows.filter(
        (r) =>
          r.status === 'pending' ||
          (r.created_at != null && r.created_at >= cutoff),
      ).length;
    } catch {
      return 0;
    }
  }
}

function blankVitalSigns(): VitalSigns {
  return {
    scheduler_alive: false,
    dispatcher_active: false,
    posts_completing: false,
    tuner_alive: false,
    validation_chain_intact: false,
  };
}

function collectFailures(v: VitalSigns): string[] {
  const out: string[] = [];
  if (!v.scheduler_alive) out.push('scheduler stalled (goal updated_at > 2h ago)');
  if (!v.dispatcher_active) out.push('dispatcher silent (0 dispatches in 24h)');
  if (!v.posts_completing) out.push('posts dispatched but none completed in 24h');
  if (!v.tuner_alive) out.push('tuner silent (0 findings in 24h)');
  if (!v.validation_chain_intact)
    out.push('knob set but no validation row enqueued');
  return out;
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isCompletedXPost(t: TaskRow, since: string): boolean {
  if (t.status !== 'completed') return false;
  if (!t.completed_at || t.completed_at < since) return false;
  const meta = parseMetadata(t.metadata);
  const via = meta.posted_via as string | undefined;
  return typeof via === 'string' && via.startsWith('x_compose');
}
