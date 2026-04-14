/**
 * StaleTaskThresholdTunerExperiment — Phase 5-C.
 *
 * First experiment that uses the full reversible-config loop:
 *   probe → judge → intervene (setRuntimeConfig)
 *        → validate (measure effect)
 *        → rollback (deleteRuntimeConfig on failure)
 *
 * Why this exists
 * ---------------
 * The stale-task-cleanup sweeper uses a hardcoded 10-minute
 * threshold. If ohwow's real task mix shifts (e.g. longer
 * legitimate tasks become common, or provider hangs become
 * more frequent), the threshold should move. Operators would
 * edit the constant and ship a new build. This experiment does
 * it automatically: reads recent cleanup findings, decides
 * whether the threshold needs adjusting, applies a change via
 * the runtime config store, validates the change 20 minutes
 * later, and rolls it back if the change made things worse.
 *
 * The decision logic is intentionally simple for Phase 5-C —
 * the point is to demonstrate the mechanic. Refinement comes
 * later when we have enough ledger data to pick better rules.
 *
 * Rules
 * -----
 *   Probe-judge:
 *     - Read the last N stale-task-cleanup findings
 *     - Compute average stale_count
 *     - If avg_stale_count >= ELEVATED_STALE_AVG (2.0) AND
 *       the most recent tuner finding was NOT a rolled-back
 *       one → return 'warning' (propose a widening)
 *     - Otherwise → return 'pass' (no adjustment)
 *
 *   Intervene (on warning):
 *     - Read current threshold from runtime-config
 *     - New threshold = current * 1.5 (loosen)
 *     - setRuntimeConfig with both values captured in details
 *
 *   Validate (20 min later):
 *     - Read stale-task-cleanup findings written SINCE the
 *       intervention
 *     - If the new avg_stale_count is lower → 'held'
 *     - If it's higher or same → 'failed'
 *     - If not enough new findings yet → 'inconclusive'
 *
 *   Rollback (on failed):
 *     - deleteRuntimeConfig for the key, reverting to the
 *       cleanup's const fallback
 *     - Record the revert in intervention details
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  ValidationResult,
  Verdict,
} from '../experiment-types.js';
import {
  STALE_THRESHOLD_CONFIG_KEY,
  currentStaleThresholdMs,
} from './stale-task-cleanup.js';
import { setRuntimeConfig, deleteRuntimeConfig } from '../runtime-config.js';

/** How many recent findings to inspect when judging cleanup health. */
const RECENT_WINDOW = 12;

/** Average stale_count above this triggers a proposed widening. */
const ELEVATED_STALE_AVG = 2.0;

/** Multiplier applied to the current threshold on widening. */
const WIDEN_MULTIPLIER = 1.5;

/** Minimum new-findings count during the validation window to make a decision. */
const MIN_VALIDATION_SAMPLES = 3;

interface TunerEvidence extends Record<string, unknown> {
  recent_stale_counts: number[];
  avg_stale_count: number;
  current_threshold_ms: number;
  proposed_threshold_ms?: number;
  last_rollback_was_this_experiment?: boolean;
}

export class StaleTaskThresholdTunerExperiment implements Experiment {
  id = 'stale-threshold-tuner';
  name = 'Stale-task threshold tuner';
  category = 'other' as const;
  hypothesis =
    'A higher STALE_THRESHOLD_MS should reduce the rate of in-progress tasks hitting the sweeper if the current threshold is catching legitimate long-running tasks. Validated after a 20-minute observation window; rolled back if the change did not reduce average stale_count.';
  cadence = { everyMs: 60 * 60 * 1000, runOnBoot: false, validationDelayMs: 20 * 60 * 1000 };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const cleanupFindings = await ctx.recentFindings('stale-task-cleanup', RECENT_WINDOW);
    const staleCounts = cleanupFindings
      .map((f) => {
        const ev = f.evidence as { stale_count?: unknown };
        return typeof ev.stale_count === 'number' ? ev.stale_count : 0;
      });

    const avg = staleCounts.length > 0
      ? staleCounts.reduce((a, b) => a + b, 0) / staleCounts.length
      : 0;

    // Check if our most recent finding was a rollback — if so, avoid
    // immediately re-proposing the same change. Give the default a
    // window to settle before trying again.
    const ownHistory = await ctx.recentFindings(this.id, 5);
    const lastOwn = ownHistory[0];
    const lastWasRollback = !!lastOwn && String(lastOwn.subject ?? '').startsWith('rollback:');

    const currentThreshold = currentStaleThresholdMs();

    const evidence: TunerEvidence = {
      recent_stale_counts: staleCounts,
      avg_stale_count: Math.round(avg * 100) / 100,
      current_threshold_ms: currentThreshold,
      last_rollback_was_this_experiment: lastWasRollback,
    };

    if (avg >= ELEVATED_STALE_AVG && !lastWasRollback) {
      evidence.proposed_threshold_ms = Math.round(currentThreshold * WIDEN_MULTIPLIER);
      return {
        subject: STALE_THRESHOLD_CONFIG_KEY,
        summary: `elevated stale_count average (${evidence.avg_stale_count} over last ${staleCounts.length}): propose widen to ${evidence.proposed_threshold_ms}ms`,
        evidence,
      };
    }

    return {
      subject: null,
      summary: lastWasRollback
        ? 'skipping proposal — last intervention was rolled back, giving default a window to settle'
        : `stale_count average ${evidence.avg_stale_count} within normal range, no adjustment needed`,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as TunerEvidence;
    if (ev.proposed_threshold_ms !== undefined) return 'warning';
    return 'pass';
  }

  async intervene(
    _verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const ev = result.evidence as TunerEvidence;
    if (ev.proposed_threshold_ms === undefined) return null;

    const oldValue = ev.current_threshold_ms;
    const newValue = ev.proposed_threshold_ms;

    await setRuntimeConfig(
      ctx.db,
      STALE_THRESHOLD_CONFIG_KEY,
      newValue,
      { setBy: this.id },
    );

    return {
      description: `widened stale_task_cleanup threshold from ${oldValue}ms to ${newValue}ms (×${WIDEN_MULTIPLIER})`,
      details: {
        config_key: STALE_THRESHOLD_CONFIG_KEY,
        old_value_ms: oldValue,
        new_value_ms: newValue,
        trigger_avg_stale_count: ev.avg_stale_count,
      },
    };
  }

  /**
   * 20 minutes after the intervention, read the stale-task-cleanup
   * findings that landed AFTER our intervention and compare their
   * avg stale_count to the trigger_avg_stale_count captured in the
   * baseline. If the new average is lower, the widening helped.
   */
  async validate(
    baseline: Record<string, unknown>,
    ctx: ExperimentContext,
  ): Promise<ValidationResult> {
    const triggerAvg = (baseline.trigger_avg_stale_count as number | undefined) ?? 0;
    const oldValue = (baseline.old_value_ms as number | undefined) ?? 0;
    const newValue = (baseline.new_value_ms as number | undefined) ?? 0;

    // Read recent cleanup findings. They're already newest-first.
    const cleanupFindings = await ctx.recentFindings('stale-task-cleanup', RECENT_WINDOW);
    const newStaleCounts = cleanupFindings
      .slice(0, MIN_VALIDATION_SAMPLES)
      .map((f) => {
        const ev = f.evidence as { stale_count?: unknown };
        return typeof ev.stale_count === 'number' ? ev.stale_count : 0;
      });

    if (newStaleCounts.length < MIN_VALIDATION_SAMPLES) {
      return {
        outcome: 'inconclusive',
        summary: `only ${newStaleCounts.length} cleanup finding(s) in validation window, need ${MIN_VALIDATION_SAMPLES}`,
        evidence: {
          trigger_avg_stale_count: triggerAvg,
          samples: newStaleCounts,
        },
      };
    }

    const newAvg =
      newStaleCounts.reduce((a, b) => a + b, 0) / newStaleCounts.length;

    if (newAvg < triggerAvg) {
      return {
        outcome: 'held',
        summary: `widening helped: avg stale_count ${Math.round(newAvg * 100) / 100} < trigger ${Math.round(triggerAvg * 100) / 100}`,
        evidence: {
          old_value_ms: oldValue,
          new_value_ms: newValue,
          trigger_avg_stale_count: triggerAvg,
          post_change_avg_stale_count: Math.round(newAvg * 100) / 100,
        },
      };
    }

    return {
      outcome: 'failed',
      summary: `widening did not help: avg stale_count ${Math.round(newAvg * 100) / 100} >= trigger ${Math.round(triggerAvg * 100) / 100}`,
      evidence: {
        old_value_ms: oldValue,
        new_value_ms: newValue,
        trigger_avg_stale_count: triggerAvg,
        post_change_avg_stale_count: Math.round(newAvg * 100) / 100,
      },
    };
  }

  /**
   * Roll back the widening by removing the override entirely. The
   * stale-task-cleanup reader falls back to its const default next
   * tick. The old value is in the baseline if a future rollback
   * wants to restore a prior non-default value instead — for Phase
   * 5-C we just delete.
   */
  async rollback(
    baseline: Record<string, unknown>,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const oldValue = (baseline.old_value_ms as number | undefined) ?? 0;
    const newValue = (baseline.new_value_ms as number | undefined) ?? 0;

    await deleteRuntimeConfig(ctx.db, STALE_THRESHOLD_CONFIG_KEY);

    return {
      description: `reverted stale_task_cleanup threshold widening from ${newValue}ms back to const default (prior override was ${oldValue}ms)`,
      details: {
        config_key: STALE_THRESHOLD_CONFIG_KEY,
        reverted_from_ms: newValue,
        original_baseline_ms: oldValue,
      },
    };
  }
}
