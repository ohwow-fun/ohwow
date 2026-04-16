/**
 * Surprise primitive — Piece 2.
 *
 * Every finding written through writeFinding() already carries a
 * `__novelty` stanza in its evidence (Piece 1). This module gives
 * experiments a one-line way to PEEK at what the novelty score WOULD
 * BE for a hypothetical observation, so judge() / intervene() can
 * branch on "is this unusual?" before the row is written.
 *
 * Typical use inside an experiment:
 *
 *   async probe(ctx) {
 *     const value = computeMyMetric();
 *     const surprise = ctx.scoreSurprise
 *       ? await ctx.scoreSurprise({
 *           subject: 'my:summary',
 *           trackedField: 'my_metric',
 *           value,
 *           verdict: 'warning',
 *         })
 *       : null;
 *     return {
 *       subject: 'my:summary',
 *       summary: `${value} (z=${surprise?.zScore?.toFixed(1) ?? 'n/a'})`,
 *       evidence: { __tracked_field: 'my_metric', my_metric: value },
 *     };
 *   }
 *
 * The runner injects ctx.scoreSurprise so experiments don't need to
 * import or wire the DB themselves.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { NewFindingRow, Verdict } from './experiment-types.js';
import {
  computeNovelty,
  readBaseline,
  type NoveltyInfo,
} from './insight-baseline.js';

export interface ScoreSurpriseInput {
  /**
   * Which subject to look up. Required because baselines key on
   * (experiment_id, subject) — the primitive cannot guess which
   * cluster a hypothetical value belongs to.
   */
  subject: string;
  /**
   * Verdict the experiment is considering. Drives the verdict-flip
   * dimension of novelty scoring.
   */
  verdict: Verdict;
  /**
   * Numeric evidence field name. When set together with `value`, the
   * primitive will z-score the value against the rolling baseline.
   */
  trackedField?: string;
  /** Numeric sample to score. Required if trackedField is set. */
  value?: number;
}

export interface SurpriseResult {
  /** novelty_score in [0..1]. 1.0 = first_seen / extreme. 0 = routine. */
  score: number;
  reason: NoveltyInfo['reason'];
  detail: string | null;
  zScore: number | null;
  /** consecutive_fails AFTER this hypothetical observation lands. */
  consecutiveFails: number;
  /** Existing baseline mean / stddev when present, for richer summaries. */
  baseline: { mean: number; stddev: number } | null;
}

/**
 * Construct a `scoreSurprise` closure the runner can attach to
 * ExperimentContext. Each experiment gets its own closure so the
 * `experimentId` is captured implicitly and call sites stay short.
 */
export function makeScoreSurprise(
  db: DatabaseAdapter,
  experimentId: string,
): (input: ScoreSurpriseInput) => Promise<SurpriseResult> {
  return async (input: ScoreSurpriseInput): Promise<SurpriseResult> => {
    const evidence: Record<string, unknown> = {};
    if (input.trackedField !== undefined && input.value !== undefined) {
      evidence.__tracked_field = input.trackedField;
      evidence[input.trackedField] = input.value;
    }
    const syntheticRow: NewFindingRow = {
      experimentId,
      category: 'other',
      subject: input.subject,
      hypothesis: null,
      verdict: input.verdict,
      summary: '',
      evidence,
      interventionApplied: null,
      ranAt: new Date().toISOString(),
      durationMs: 0,
    };

    const baseline = await readBaseline(db, experimentId, input.subject);
    const novelty = computeNovelty(baseline, syntheticRow);

    let baselineSummary: { mean: number; stddev: number } | null = null;
    if (
      baseline &&
      baseline.tracked_field === (input.trackedField ?? null) &&
      baseline.running_mean !== null &&
      baseline.running_m2 !== null &&
      baseline.sample_count >= 2
    ) {
      const variance = baseline.running_m2 / Math.max(baseline.sample_count - 1, 1);
      baselineSummary = {
        mean: baseline.running_mean,
        stddev: Math.sqrt(variance),
      };
    }

    return {
      score: novelty.score,
      reason: novelty.reason,
      detail: novelty.detail,
      zScore: novelty.z_score,
      consecutiveFails: novelty.consecutive_fails,
      baseline: baselineSummary,
    };
  };
}
