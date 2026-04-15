/**
 * ContentCadenceTunerExperiment — first concrete BusinessExperiment.
 *
 * Why this exists
 * ---------------
 * Self-bench today tunes infrastructure knobs (stale-task threshold,
 * agent-tier model demotion). The next hop is tuning knobs that
 * affect business outcomes. This experiment is the minimum thing that
 * exercises the full loop end-to-end on the business side:
 *
 *   1. Anchored to a real goal (target_metric='x_posts_per_week')
 *      instead of an internal metric. If the goal doesn't exist, the
 *      experiment passes — it can't run without an external target.
 *   2. Writes a reversible runtime_config knob
 *      ('content_cadence.posts_per_day'), not an outbound action.
 *      Whatever scheduler actually posts to X reads this knob. The
 *      experiment only tunes the knob; it never touches the posting
 *      path itself. That's what makes this a safe first step — the
 *      full outbound loop stays human-in-the-loop until later phases
 *      teach an experiment to mutate outbound state.
 *   3. Validates 24h later against goal.current_value. If the goal
 *      moved by at least half the required daily velocity, held.
 *      Otherwise failed, and rollback removes the knob override so
 *      the default const takes over again.
 *
 * It intentionally mirrors stale-threshold-tuner.ts one-for-one:
 *   - probe reads the latest state
 *   - judge emits warning when an adjustment is warranted
 *   - intervene writes a single runtime_config key
 *   - validate compares post-window evidence to baseline
 *   - rollback deletes the key
 *
 * The one new thing here is the base class: every infra tuner
 * implements workspace guards by hand, but business tuners inherit
 * them from BusinessExperiment and only have to think about the
 * probe/judge/intervene domain logic.
 *
 * Safety rails
 * ------------
 * - DAILY_INTERVENTION_CAP = 1: at most one knob change per 24h window.
 *   The interventionCapReached helper reads the ledger, so this cap
 *   survives daemon restarts.
 * - CONTENT_CADENCE_MAX = 5: never propose more than 5 posts/day, even
 *   if required velocity is higher. Prevents a runaway goal (target
 *   value 1000 due tomorrow) from cranking the knob into banland.
 * - Observer-only when no goal exists. No goal = no target = no
 *   intervention. The experiment returns 'pass' with a `no_goal`
 *   reason, so operators can see it's running but intentionally idle.
 * - Inherits the BusinessExperiment workspace guard — this only runs
 *   on the 'default' workspace unless explicitly constructed with a
 *   different allowedWorkspace.
 */

import type {
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  ValidationResult,
  Verdict,
} from '../experiment-types.js';
import { BusinessExperiment } from '../business-experiment.js';
import {
  getRuntimeConfig,
  setRuntimeConfig,
  deleteRuntimeConfig,
} from '../runtime-config.js';

/** Runtime config key the downstream posting scheduler reads. */
export const CONTENT_CADENCE_CONFIG_KEY = 'content_cadence.posts_per_day';

/** Default posts/day when no override is set. */
export const CONTENT_CADENCE_DEFAULT = 1;

/** Hard ceiling on posts/day proposals. */
export const CONTENT_CADENCE_MAX = 5;

/** Goal target_metric this experiment looks for. */
export const CONTENT_CADENCE_GOAL_METRIC = 'x_posts_per_week';

const VALIDATION_DELAY_MS = 24 * 60 * 60 * 1000;
const DAILY_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAILY_INTERVENTION_CAP = 1;

/** Fraction of required-per-day the goal must move during validation. */
const VALIDATION_DELTA_FRACTION = 0.5;

export function currentContentCadence(): number {
  return getRuntimeConfig<number>(CONTENT_CADENCE_CONFIG_KEY, CONTENT_CADENCE_DEFAULT);
}

interface TunerEvidence extends Record<string, unknown> {
  goal_id?: string;
  goal_title?: string;
  current_value?: number;
  target_value?: number;
  days_remaining?: number;
  remaining_value?: number;
  required_per_day?: number;
  current_cadence: number;
  proposed_cadence?: number;
  max_cadence: number;
  should_widen?: boolean;
  reason?: string;
}

export class ContentCadenceTunerExperiment extends BusinessExperiment {
  id = 'content-cadence-tuner';
  name = 'Content cadence tuner (X posts/day knob)';
  hypothesis =
    `When an active goal with target_metric='${CONTENT_CADENCE_GOAL_METRIC}' is behind its required daily velocity, widening ${CONTENT_CADENCE_CONFIG_KEY} up to ${CONTENT_CADENCE_MAX} posts/day should raise current_value. Validated 24h later against goal.current_value delta; rolled back if the delta did not meet half the required daily velocity.`;
  cadence = {
    everyMs: 6 * 60 * 60 * 1000,
    runOnBoot: false,
    validationDelayMs: VALIDATION_DELAY_MS,
  };

  protected async businessProbe(ctx: ExperimentContext): Promise<ProbeResult> {
    const currentCadence = currentContentCadence();
    const goal = await this.findActiveGoalByMetric(ctx, CONTENT_CADENCE_GOAL_METRIC);

    if (!goal) {
      const evidence: TunerEvidence = {
        current_cadence: currentCadence,
        max_cadence: CONTENT_CADENCE_MAX,
        reason: 'no_goal',
      };
      return {
        subject: null,
        summary: `no active goal with target_metric='${CONTENT_CADENCE_GOAL_METRIC}' — nothing to tune toward`,
        evidence,
      };
    }

    const velocity = this.computeRequiredVelocity(goal);

    if (!velocity) {
      const evidence: TunerEvidence = {
        goal_id: goal.id,
        goal_title: goal.title,
        current_value: goal.currentValue,
        target_value: goal.targetValue,
        current_cadence: currentCadence,
        max_cadence: CONTENT_CADENCE_MAX,
        reason: goal.dueDate ? 'goal_met_or_past_due' : 'goal_missing_due_date',
      };
      return {
        subject: `goal:${goal.id}`,
        summary: `goal '${goal.title}' not tunable (current=${goal.currentValue}/${goal.targetValue}, reason=${evidence.reason})`,
        evidence,
      };
    }

    // Propose a cadence that covers the required daily velocity,
    // but never below the current cadence (don't ratchet down here —
    // a separate experiment can do that) and never above the max.
    const proposedCadence = Math.min(
      CONTENT_CADENCE_MAX,
      Math.max(currentCadence, Math.ceil(velocity.requiredPerDay - 1e-9)),
    );
    const shouldWiden = proposedCadence > currentCadence;

    const evidence: TunerEvidence = {
      goal_id: goal.id,
      goal_title: goal.title,
      current_value: goal.currentValue,
      target_value: goal.targetValue,
      days_remaining: Math.round(velocity.daysRemaining * 10) / 10,
      remaining_value: velocity.remainingValue,
      required_per_day: Math.round(velocity.requiredPerDay * 100) / 100,
      current_cadence: currentCadence,
      proposed_cadence: proposedCadence,
      max_cadence: CONTENT_CADENCE_MAX,
      should_widen: shouldWiden,
    };

    const summary = shouldWiden
      ? `velocity gap for '${goal.title}': need ${evidence.required_per_day}/day, knob at ${currentCadence}/day → propose ${proposedCadence}/day`
      : `goal '${goal.title}' on track at knob ${currentCadence}/day (required ${evidence.required_per_day}/day)`;

    return {
      subject: `goal:${goal.id}`,
      summary,
      evidence,
    };
  }

  protected businessJudge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as TunerEvidence;
    return ev.should_widen === true ? 'warning' : 'pass';
  }

  protected async businessIntervene(
    _verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const ev = result.evidence as TunerEvidence;
    if (
      ev.should_widen !== true ||
      ev.proposed_cadence === undefined ||
      ev.current_cadence === undefined
    ) {
      return null;
    }

    // Hard daily cap on knob changes. This is the business-side
    // substitute for true reversibility — we can't unsend posts that
    // already flew, so we bound how often we can move the goalposts.
    if (await this.interventionCapReached(ctx, DAILY_INTERVENTION_CAP, DAILY_CAP_WINDOW_MS)) {
      return null;
    }

    const oldValue = ev.current_cadence;
    const newValue = ev.proposed_cadence;

    await setRuntimeConfig(ctx.db, CONTENT_CADENCE_CONFIG_KEY, newValue, { setBy: this.id });

    return {
      description: `widened ${CONTENT_CADENCE_CONFIG_KEY} from ${oldValue} to ${newValue} (required ${ev.required_per_day}/day for goal ${ev.goal_id})`,
      details: {
        config_key: CONTENT_CADENCE_CONFIG_KEY,
        old_value: oldValue,
        new_value: newValue,
        goal_id: ev.goal_id,
        required_per_day: ev.required_per_day,
        goal_current_value_at_intervention: ev.current_value ?? 0,
        reversible: true,
      },
    };
  }

  /**
   * 24 hours after a widening, re-read the goal and ask: did
   * current_value move by at least half the required daily velocity?
   *
   * Half is a deliberate leniency — goals have reporting lag, the
   * posting scheduler runs on its own cadence, and weekend effects
   * mean a single 24h window is noisy. If even half the required
   * movement didn't land, the widening genuinely isn't working and
   * rollback should fire.
   */
  async validate(
    baseline: Record<string, unknown>,
    ctx: ExperimentContext,
  ): Promise<ValidationResult> {
    const goalId = baseline.goal_id as string | undefined;
    const oldValue = baseline.old_value as number | undefined;
    const newValue = baseline.new_value as number | undefined;
    const baselineGoalValue =
      (baseline.goal_current_value_at_intervention as number | undefined) ?? 0;
    const requiredPerDay = (baseline.required_per_day as number | undefined) ?? 0;

    if (!goalId) {
      return {
        outcome: 'inconclusive',
        summary: 'baseline missing goal_id — nothing to validate',
        evidence: { ...baseline },
      };
    }

    let currentGoalValue: number;
    try {
      const res = await ctx.db
        .from<{ id: string; current_value: number | null }>('agent_workforce_goals')
        .select('id, current_value')
        .eq('id', goalId);
      const rows = ((res as { data?: Array<{ id: string; current_value: number | null }> | null }).data ?? []) as Array<{ id: string; current_value: number | null }>;
      const row = rows[0];
      if (!row) {
        return {
          outcome: 'inconclusive',
          summary: `goal ${goalId} no longer exists`,
          evidence: { goal_id: goalId, old_value: oldValue, new_value: newValue },
        };
      }
      currentGoalValue = Number(row.current_value ?? 0);
    } catch (err) {
      return {
        outcome: 'inconclusive',
        summary: `goal lookup failed for ${goalId}`,
        evidence: { goal_id: goalId, err: String(err) },
      };
    }

    const delta = currentGoalValue - baselineGoalValue;
    const expectedDeltaFloor = requiredPerDay * VALIDATION_DELTA_FRACTION;

    const evidence: Record<string, unknown> = {
      goal_id: goalId,
      old_cadence: oldValue,
      new_cadence: newValue,
      baseline_goal_value: baselineGoalValue,
      post_window_goal_value: currentGoalValue,
      delta: Math.round(delta * 100) / 100,
      expected_delta_floor: Math.round(expectedDeltaFloor * 100) / 100,
      required_per_day: requiredPerDay,
    };

    if (delta >= expectedDeltaFloor) {
      return {
        outcome: 'held',
        summary: `widening worked: goal ${goalId} moved by ${evidence.delta} (floor ${evidence.expected_delta_floor}) over 24h`,
        evidence,
      };
    }

    return {
      outcome: 'failed',
      summary: `widening did not move the goal: delta ${evidence.delta} < floor ${evidence.expected_delta_floor}`,
      evidence,
    };
  }

  /**
   * Remove the runtime_config override so the downstream posting
   * scheduler falls back to CONTENT_CADENCE_DEFAULT on its next read.
   * The baseline's old_value is captured but not restored — Phase-1
   * rollback just deletes, same as stale-threshold-tuner.
   */
  async rollback(
    baseline: Record<string, unknown>,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const oldValue = baseline.old_value as number | undefined;
    const newValue = baseline.new_value as number | undefined;

    await deleteRuntimeConfig(ctx.db, CONTENT_CADENCE_CONFIG_KEY);

    return {
      description: `reverted ${CONTENT_CADENCE_CONFIG_KEY} widening from ${newValue} back to const default (prior override was ${oldValue})`,
      details: {
        config_key: CONTENT_CADENCE_CONFIG_KEY,
        reverted_from: newValue,
        original_baseline: oldValue,
        reversible: true,
      },
    };
  }
}
