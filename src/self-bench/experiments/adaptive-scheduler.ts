/**
 * AdaptiveSchedulerExperiment — the Phase 4 meta-loop.
 *
 * Every 10 minutes this experiment reads the ledger, inspects the
 * recent finding history of every OTHER registered experiment, and
 * applies two scheduling rules by calling ctx.scheduler.setNextRunAt:
 *
 *   Rule 1 — Pass-streak stretch
 *     If an experiment has N or more consecutive 'pass' findings
 *     with no interventions and no errors, its next-run timestamp
 *     is pushed out by a multiplier that scales with the streak:
 *       10-19 passes → 1.5x cadence
 *       20-49 passes → 2x
 *       50-99 passes → 3x
 *       100+  passes → 4x (capped)
 *     Rationale: a healthy check that's been green 100x in a row
 *     doesn't need to burn probe budget every 10 minutes. Spending
 *     that budget elsewhere is free expected value.
 *
 *   Rule 2 — Failure pull-in
 *     If any of the experiment's last 3 findings is 'fail', the
 *     next-run timestamp is pulled in to now+60s. Aggressively
 *     re-probe anything that looked broken recently so the signal
 *     is fresh when an operator or a Claude session is investigating.
 *     Takes precedence over Rule 1 — a fail overrides any accumulated
 *     pass streak.
 *
 * This is the first experiment that reads the ledger to decide what
 * OTHER experiments should do. It's the load-bearing mechanic for
 * "non-stop self-improvement" because it moves probe budget toward
 * signal automatically. Without it, every experiment runs on a fixed
 * cadence forever regardless of how interesting its findings have
 * been.
 *
 * Self-reference guard: the scheduler skips its own id so it never
 * modifies its own nextRunAt. A meta-loop modifying itself is a
 * feedback loop waiting to happen.
 *
 * No validate(): the meta-loop's "intervention" is a cadence
 * adjustment whose effect takes weeks to measure in a meaningful
 * way. A validate at T+15min would just observe "the experiment
 * that's pulled in ran once more, as expected." Not load-bearing
 * accountability — future phase can add long-window validation
 * comparing before/after probe efficiency.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

/** How many consecutive pass findings trigger the smallest stretch tier. */
const STREAK_STRETCH_THRESHOLD = 10;
/** How many recent findings to inspect for Rule 2 (failure pull-in). */
const FAILURE_WINDOW = 3;
/** When pulling in after a failure, schedule next run this far from now. */
const PULL_IN_DELAY_MS = 60 * 1000;
/** How many recent findings to inspect for Rule 1 (streak check). */
const STREAK_HISTORY_LIMIT = 120;

/**
 * Compute the multiplier for a given consecutive-pass streak.
 * Returns 1.0 when no stretch should apply.
 */
export function stretchMultiplierForStreak(streak: number): number {
  if (streak < STREAK_STRETCH_THRESHOLD) return 1.0;
  if (streak < 20) return 1.5;
  if (streak < 50) return 2.0;
  if (streak < 100) return 3.0;
  return 4.0;
}

interface AdjustmentRecord {
  experiment_id: string;
  name: string;
  rule: 'pass_streak_stretch' | 'failure_pull_in';
  streak?: number;
  multiplier?: number;
  recent_fail_count?: number;
  old_next_run_at: number;
  new_next_run_at: number;
  delta_ms: number;
}

interface AdaptiveSchedulerEvidence extends Record<string, unknown> {
  inspected_count: number;
  adjusted_count: number;
  stretched_count: number;
  pulled_in_count: number;
  adjustments: AdjustmentRecord[];
}

export class AdaptiveSchedulerExperiment implements Experiment {
  id = 'adaptive-scheduler';
  name = 'Meta-loop: adjust peer experiment cadences';
  category = 'other' as const;
  hypothesis =
    'Probe budget should follow signal. Healthy experiments that have been green for many runs can be probed less often, and experiments that just failed should be re-probed aggressively.';
  cadence = { everyMs: 10 * 60 * 1000, runOnBoot: false };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const scheduler = ctx.scheduler;
    if (!scheduler) {
      return {
        subject: null,
        summary: 'no scheduler in context — running outside a runner',
        evidence: {
          inspected_count: 0,
          adjusted_count: 0,
          stretched_count: 0,
          pulled_in_count: 0,
          adjustments: [] as AdjustmentRecord[],
        } as AdaptiveSchedulerEvidence,
      };
    }

    const peers = scheduler.getRegisteredExperimentInfo().filter((p) => p.id !== this.id);
    const adjustments: AdjustmentRecord[] = [];

    for (const peer of peers) {
      const history = await ctx.recentFindings(peer.id, STREAK_HISTORY_LIMIT);
      if (history.length === 0) continue;

      // Rule 2 takes precedence: any fail in the last N findings
      // means pull in aggressively.
      const recentFails = history.slice(0, FAILURE_WINDOW).filter((f) => f.verdict === 'fail');
      if (recentFails.length > 0) {
        adjustments.push(this.pullIn(peer, recentFails.length));
        continue;
      }

      // Rule 1: count consecutive pass findings from newest.
      let streak = 0;
      for (const f of history) {
        if (f.verdict !== 'pass') break;
        // A run with an intervention counts as a successful action
        // but isn't "quiet" — don't let it contribute to the stretch
        // streak. The experiment intervened for a reason; we want to
        // keep watching it.
        if (f.interventionApplied !== null) break;
        streak += 1;
      }

      const multiplier = stretchMultiplierForStreak(streak);
      if (multiplier > 1.0) {
        adjustments.push(this.stretch(peer, streak, multiplier));
      }
    }

    const stretchedCount = adjustments.filter((a) => a.rule === 'pass_streak_stretch').length;
    const pulledInCount = adjustments.filter((a) => a.rule === 'failure_pull_in').length;

    // Keep only the 20 largest-delta adjustments in evidence to avoid
    // serialising 100+ schedule objects on every run.
    const topAdjustments = adjustments
      .slice()
      .sort((a, b) => Math.abs(b.delta_ms) - Math.abs(a.delta_ms))
      .slice(0, 20);

    const evidence: AdaptiveSchedulerEvidence = {
      inspected_count: peers.length,
      adjusted_count: adjustments.length,
      stretched_count: stretchedCount,
      pulled_in_count: pulledInCount,
      adjustments: topAdjustments,
    };

    const summary = adjustments.length === 0
      ? `inspected ${peers.length} peer experiment(s), no adjustments needed`
      : `adjusted ${adjustments.length} of ${peers.length} peer experiment(s): ${stretchedCount} stretched, ${pulledInCount} pulled in`;

    return {
      subject: null,
      summary,
      evidence,
    };
  }

  private pullIn(
    peer: { id: string; name: string; nextRunAt: number },
    failCount: number,
  ): AdjustmentRecord {
    const oldNext = peer.nextRunAt;
    const newNext = Date.now() + PULL_IN_DELAY_MS;
    return {
      experiment_id: peer.id,
      name: peer.name,
      rule: 'failure_pull_in',
      recent_fail_count: failCount,
      old_next_run_at: oldNext,
      new_next_run_at: newNext,
      delta_ms: newNext - oldNext,
    };
  }

  private stretch(
    peer: { id: string; name: string; cadence: { everyMs: number }; nextRunAt: number },
    streak: number,
    multiplier: number,
  ): AdjustmentRecord {
    const oldNext = peer.nextRunAt;
    const newNext = Date.now() + peer.cadence.everyMs * multiplier;
    return {
      experiment_id: peer.id,
      name: peer.name,
      rule: 'pass_streak_stretch',
      streak,
      multiplier,
      old_next_run_at: oldNext,
      new_next_run_at: newNext,
      delta_ms: newNext - oldNext,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as AdaptiveSchedulerEvidence;
    // Adjusting peer cadences is a routine meta-loop operation.
    // Pulling in after failures is expected and not a "warning" at
    // the scheduler level — the underlying experiment is what's
    // reporting the failure, and that's already in the ledger.
    // Stretching pass streaks is a clean pass for the scheduler.
    if (ev.inspected_count === 0) return 'warning';
    return 'pass';
  }

  async intervene(
    _verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const ev = result.evidence as AdaptiveSchedulerEvidence;
    if (ev.adjustments.length === 0) return null;

    const scheduler = ctx.scheduler;
    if (!scheduler) return null;

    // Apply every adjustment from the probe. The probe computed
    // them but didn't apply — intervene is the mutation step.
    // Doing it here (not in probe) keeps probe idempotent, which
    // matters for testability and for the runner's "run probe but
    // skip intervene" options added in later phases.
    for (const adj of ev.adjustments) {
      scheduler.setNextRunAt(adj.experiment_id, adj.new_next_run_at);
    }

    return {
      description: `Adjusted ${ev.adjustments.length} peer cadence(s): ${ev.stretched_count} stretched, ${ev.pulled_in_count} pulled in`,
      details: {
        adjustments: ev.adjustments,
        stretched_count: ev.stretched_count,
        pulled_in_count: ev.pulled_in_count,
      },
    };
  }
}
