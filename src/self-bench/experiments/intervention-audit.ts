/**
 * InterventionAuditExperiment — reads experiment_validations and
 * surfaces which experiments are actually moving their probe state
 * vs. which are just writing cosmetic "intervention applied" rows.
 *
 * Hold rate (held / completed) is the signal. Experiments below the
 * performative threshold over a minimum sample land on the new
 * strategy.performative_experiments advisory so the strategist and
 * cold-prompt readers can call them out by name.
 *
 * Why not fold this into StrategistExperiment?
 * --------------------------------------------
 * The strategist's inputs are aggregate-state snapshots. This probe's
 * inputs are rows across two tables (validations + findings) with a
 * non-trivial join — keeping it separate means the strategist's
 * rule surface stays declarative and this probe owns the query.
 */

import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { setRuntimeConfig } from '../runtime-config.js';

export const STRATEGY_PERFORMATIVE_KEY = 'strategy.performative_experiments';
export const STRATEGY_UNMEASURABLE_KEY = 'strategy.unmeasurable_experiments';

interface ValidationRow {
  experiment_id: string;
  outcome: string | null;
  status: string;
  completed_at: string | null;
}

interface PerformativeRow {
  experiment_id: string;
  completed: number;
  held: number;
  failed: number;
  inconclusive: number;
  hold_rate: number;
}

interface AuditEvidence extends Record<string, unknown> {
  experiments: PerformativeRow[];
  performative: string[];
  unmeasurable: string[];
  /**
   * Burn-down scalars for autoFollowupValidate. The `_count` suffix is
   * load-bearing: the validator reads these as pools that should shrink
   * after the intervention (flagged experiments recover and drop off
   * the lists). Without them, pre=warning/post=warning validations
   * always read as "failed" and the audit probe flags itself as
   * performative in a self-confirming loop.
   */
  performative_count: number;
  unmeasurable_count: number;
  total_completed: number;
  total_held: number;
  total_inconclusive: number;
  overall_hold_rate: number | null;
  min_sample: number;
  hold_rate_floor: number;
  window_hours: number;
}

/**
 * Experiments below this hold rate over MIN_SAMPLE completed
 * validations get flagged as performative. 20% is generous — a loop
 * doing real work should clear half. The strategist then demotes
 * them the same way it demotes burn-heavy experiments.
 */
const HOLD_RATE_FLOOR = 0.2;
const MIN_SAMPLE = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export class InterventionAuditExperiment implements Experiment {
  readonly id = 'intervention-audit';
  readonly name = 'Audit intervention effectiveness by hold rate';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'Every experiment that intervenes should hold more often than it fails; a persistent low hold rate means the intervention is cosmetic — it writes a finding but does not change the probed state.';
  readonly cadence = { everyMs: 30 * 60 * 1000, runOnBoot: true };
  // Opt out of suffix-based burn-down detection. performative_count
  // and unmeasurable_count are this audit's own readings of the
  // ledger, not pools its intervene() drains. Treating them as
  // burn-down made every flat audit run resolve to 'failed' against
  // itself — a self-referential false positive. With burn-down
  // disabled, flat-verdict auto-followups route through the
  // inconclusive branch (experiment-runner.ts:231) as intended.
  readonly burnDownKeys: string[] = [];

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();

    let rows: ValidationRow[] = [];
    try {
      const { data } = await ctx.db
        .from<ValidationRow>('experiment_validations')
        .select('experiment_id, outcome, status, completed_at')
        .eq('status', 'completed')
        .gte('completed_at', since)
        .limit(10_000);
      rows = (data ?? []) as ValidationRow[];
    } catch (err) {
      return {
        subject: 'meta:intervention-audit',
        summary: `intervention-audit probe failed: ${err instanceof Error ? err.message : String(err)}`,
        evidence: {
          experiments: [],
          performative: [],
          unmeasurable: [],
          performative_count: 0,
          unmeasurable_count: 0,
          total_completed: 0,
          total_held: 0,
          total_inconclusive: 0,
          overall_hold_rate: null,
          min_sample: MIN_SAMPLE,
          hold_rate_floor: HOLD_RATE_FLOOR,
          window_hours: WINDOW_MS / 3_600_000,
          error: true,
        } satisfies AuditEvidence & { error: boolean },
      };
    }

    const counts = new Map<
      string,
      { held: number; failed: number; inconclusive: number }
    >();
    for (const r of rows) {
      if (!r.experiment_id) continue;
      const bucket =
        counts.get(r.experiment_id) ?? { held: 0, failed: 0, inconclusive: 0 };
      if (r.outcome === 'held') bucket.held += 1;
      else if (r.outcome === 'failed') bucket.failed += 1;
      else if (r.outcome === 'inconclusive') bucket.inconclusive += 1;
      counts.set(r.experiment_id, bucket);
    }

    const experiments: PerformativeRow[] = [];
    for (const [experimentId, c] of counts) {
      // Inconclusive rows are excluded from the hold-rate denominator
      // on purpose — they mean "we could not measure," not "it didn't
      // work." Counting them as failed would penalize probes whose
      // validation is structurally unmeasurable (no burn-down scalars).
      const completed = c.held + c.failed;
      if (completed === 0 && c.inconclusive === 0) continue;
      experiments.push({
        experiment_id: experimentId,
        completed,
        held: c.held,
        failed: c.failed,
        inconclusive: c.inconclusive,
        hold_rate:
          completed > 0 ? Math.round((c.held / completed) * 100) / 100 : 0,
      });
    }
    experiments.sort(
      (a, b) => b.completed + b.inconclusive - (a.completed + a.inconclusive),
    );

    // Unmeasurable takes precedence: any experiment producing
    // MIN_SAMPLE+ inconclusive validations has a measurability problem
    // worth surfacing on its own. The earlier "inconclusive > held +
    // failed" criterion was too strict — it kept experiments stuck in
    // the performative bucket whenever stale pre-fix `failed` rows
    // dominated the window, even after the validator started correctly
    // emitting inconclusive. Once an experiment is unmeasurable, it is
    // explicitly NOT performative — "performative" means measurable and
    // failing, which is incompatible with "we can't measure it."
    const unmeasurableSet = new Set(
      experiments
        .filter((e) => e.inconclusive >= MIN_SAMPLE)
        .map((e) => e.experiment_id),
    );
    const unmeasurable = Array.from(unmeasurableSet);

    const performative = experiments
      .filter(
        (e) =>
          !unmeasurableSet.has(e.experiment_id) &&
          e.completed >= MIN_SAMPLE &&
          e.hold_rate < HOLD_RATE_FLOOR,
      )
      .map((e) => e.experiment_id);

    const totalCompleted = experiments.reduce((s, e) => s + e.completed, 0);
    const totalHeld = experiments.reduce((s, e) => s + e.held, 0);
    const totalInconclusive = experiments.reduce(
      (s, e) => s + e.inconclusive,
      0,
    );
    const overallHoldRate =
      totalCompleted > 0 ? Math.round((totalHeld / totalCompleted) * 100) / 100 : null;

    const evidence: AuditEvidence = {
      experiments,
      performative,
      unmeasurable,
      performative_count: performative.length,
      unmeasurable_count: unmeasurable.length,
      total_completed: totalCompleted,
      total_held: totalHeld,
      total_inconclusive: totalInconclusive,
      overall_hold_rate: overallHoldRate,
      min_sample: MIN_SAMPLE,
      hold_rate_floor: HOLD_RATE_FLOOR,
      window_hours: WINDOW_MS / 3_600_000,
    };

    const parts: string[] = [];
    if (performative.length > 0) parts.push(`performative: ${performative.join(', ')}`);
    if (unmeasurable.length > 0) parts.push(`unmeasurable: ${unmeasurable.join(', ')}`);
    const summary =
      totalCompleted === 0 && totalInconclusive === 0
        ? 'no completed validations yet — hold rate unmeasurable'
        : `overall ${Math.round((overallHoldRate ?? 0) * 100)}% hold (${totalHeld}/${totalCompleted})${
            parts.length > 0 ? `; ${parts.join('; ')}` : ''
          }`;

    return { subject: 'meta:intervention-audit', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as AuditEvidence & { error?: boolean };
    if (ev.error) return 'warning';
    if (ev.total_completed === 0 && ev.total_inconclusive === 0) return 'pass';
    if (ev.performative.length > 0) return 'warning';
    if (ev.unmeasurable.length > 0) return 'warning';
    if (ev.overall_hold_rate !== null && ev.overall_hold_rate < 0.5) return 'warning';
    return 'pass';
  }

  async intervene(
    _verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const ev = result.evidence as AuditEvidence & { error?: boolean };
    if (ev.error) return null;
    try {
      await setRuntimeConfig(ctx.db, STRATEGY_PERFORMATIVE_KEY, ev.performative, {
        setBy: this.id,
      });
      await setRuntimeConfig(ctx.db, STRATEGY_UNMEASURABLE_KEY, ev.unmeasurable, {
        setBy: this.id,
      });
    } catch {
      // best-effort — the finding still lands
      return null;
    }
    const parts: string[] = [];
    if (ev.performative.length > 0)
      parts.push(`${ev.performative.length} performative`);
    if (ev.unmeasurable.length > 0)
      parts.push(`${ev.unmeasurable.length} unmeasurable`);
    return {
      description:
        parts.length === 0
          ? 'cleared performative + unmeasurable lists (nothing to flag)'
          : `flagged ${parts.join(', ')} experiment(s)`,
      details: {
        performative: ev.performative,
        unmeasurable: ev.unmeasurable,
        overall_hold_rate: ev.overall_hold_rate,
      },
    };
  }
}
