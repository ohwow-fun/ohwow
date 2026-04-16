/**
 * Insight baselines — per-(experiment, subject) rolling stats used by
 * the insight distiller to tell "first-seen / unusual / extreme"
 * observations apart from routine repetitions.
 *
 * The findings-store calls `applyNoveltyOnWrite()` inside the same
 * writeFinding() transaction so every row landing in self_findings
 * already carries a `__novelty` stanza in its evidence JSON. The
 * distiller (REST + MCP) ranks by novelty_score descending so the
 * operator sees the unusual things first without having to skim the
 * full firehose.
 *
 * Novelty dimensions (max wins):
 *   - first_seen: no prior baseline row → score 1.0
 *   - verdict_flipped: last verdict was pass and current is warning/
 *     fail (or vice versa) → score 0.9
 *   - value_z: |x - mean| / stddev where x is evidence[trackedField];
 *     only when sample_count >= MIN_SAMPLES_FOR_Z. z >= 3 → 0.95,
 *     2 <= z < 3 → 0.7, 1 <= z < 2 → 0.3.
 *   - repeat_count: consecutive_fails crossing {10, 50, 100, 500}
 *     milestones → score 0.5 at each threshold. Below the first
 *     milestone this dimension is silent so we don't spam novelty
 *     on every fail; above 500 we stop re-flagging.
 *   - else: score 0.0 ("normal").
 *
 * The tracked_field convention: an experiment that wants Welford
 * tracking on a numeric evidence field writes
 *   evidence.__tracked_field = 'dispatch_success_rate'
 * and ensures evidence.dispatch_success_rate is a number. Omitting
 * the hint means the baseline carries no running stats and novelty
 * comes only from verdict flips + first-seen + fail-streak milestones.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { NewFindingRow, Verdict } from './experiment-types.js';

/** Minimum sample count before we trust the running mean enough to z-score. */
const MIN_SAMPLES_FOR_Z = 5;

/** Consecutive-fail milestones that fire a novelty signal. Beyond the */
/** last entry the dimension goes silent to avoid permanent noise.    */
const FAIL_STREAK_MILESTONES = [10, 50, 100, 500] as const;

export interface ObservationBaselineRow {
  experiment_id: string;
  subject: string;
  first_seen_at: string;
  last_seen_at: string;
  sample_count: number;
  tracked_field: string | null;
  running_mean: number | null;
  running_m2: number | null;
  last_value: number | null;
  last_verdict: string | null;
  consecutive_fails: number;
  updated_at: string;
}

export type NoveltyReason =
  | 'first_seen'
  | 'verdict_flipped'
  | 'value_z'
  | 'repeat_count'
  | 'normal';

export interface NoveltyInfo {
  score: number;
  reason: NoveltyReason;
  detail: string | null;
  z_score: number | null;
  repeat_count: number;
  consecutive_fails: number;
}

/**
 * Pure scoring. Given the existing baseline (or null when first-seen)
 * and the incoming finding, pick the dominant novelty dimension and
 * return the score + human-readable detail. No DB access.
 */
export function computeNovelty(
  baseline: ObservationBaselineRow | null,
  row: NewFindingRow,
): NoveltyInfo {
  const verdict = row.verdict;
  const evidence = (row.evidence ?? {}) as Record<string, unknown>;
  const trackedField = typeof evidence.__tracked_field === 'string'
    ? evidence.__tracked_field
    : null;
  const rawValue = trackedField ? evidence[trackedField] : undefined;
  const currentValue = typeof rawValue === 'number' && Number.isFinite(rawValue)
    ? rawValue
    : null;

  if (!baseline) {
    return {
      score: 1.0,
      reason: 'first_seen',
      detail: null,
      z_score: null,
      repeat_count: 0,
      consecutive_fails: verdict === 'warning' || verdict === 'fail' ? 1 : 0,
    };
  }

  // Derived post-write stats we return so callers can persist + display.
  const nextConsecutiveFails = verdict === 'warning' || verdict === 'fail'
    ? baseline.consecutive_fails + 1
    : 0;

  let score = 0;
  let reason: NoveltyReason = 'normal';
  let detail: string | null = null;
  let zScore: number | null = null;

  // Verdict flip dimension.
  if (baseline.last_verdict && baseline.last_verdict !== verdict) {
    const was = baseline.last_verdict;
    if (was === 'pass' && (verdict === 'warning' || verdict === 'fail')) {
      score = Math.max(score, 0.9);
      reason = 'verdict_flipped';
      detail = `${was}→${verdict}`;
    } else if (verdict === 'pass' && (was === 'warning' || was === 'fail')) {
      score = Math.max(score, 0.9);
      reason = 'verdict_flipped';
      detail = `${was}→${verdict}`;
    }
  }

  // z-score dimension.
  if (
    trackedField &&
    currentValue !== null &&
    baseline.tracked_field === trackedField &&
    baseline.sample_count >= MIN_SAMPLES_FOR_Z &&
    baseline.running_mean !== null &&
    baseline.running_m2 !== null
  ) {
    const variance = baseline.running_m2 / Math.max(baseline.sample_count - 1, 1);
    const stddev = Math.sqrt(variance);
    if (stddev > 0) {
      const z = Math.abs(currentValue - baseline.running_mean) / stddev;
      zScore = z;
      let zScoreDim = 0;
      if (z >= 3) zScoreDim = 0.95;
      else if (z >= 2) zScoreDim = 0.7;
      else if (z >= 1) zScoreDim = 0.3;
      if (zScoreDim > score) {
        score = zScoreDim;
        reason = 'value_z';
        detail = `z=${z.toFixed(1)} (value=${currentValue}, baseline ${baseline.running_mean.toFixed(2)}±${stddev.toFixed(2)})`;
      }
    }
  }

  // Repeat-count dimension. Only emit on crossing milestones so the
  // signal doesn't sit pinned for hours once a stuck fail crosses the
  // first threshold.
  if (FAIL_STREAK_MILESTONES.includes(nextConsecutiveFails as 10)) {
    const streakDim = 0.5;
    if (streakDim > score) {
      score = streakDim;
      reason = 'repeat_count';
      detail = `consecutive_fails=${nextConsecutiveFails}`;
    }
  }

  return {
    score,
    reason,
    detail,
    z_score: zScore,
    repeat_count: baseline.sample_count + 1,
    consecutive_fails: nextConsecutiveFails,
  };
}

/**
 * Welford's online update. Given the existing baseline (or null) plus
 * the new sample, return the new mean, M2, count, and retained
 * tracked_field. Callers feed this into writeBaseline() — separate from
 * novelty scoring so the tests can exercise the stat math directly.
 */
export function welfordUpdate(
  baseline: ObservationBaselineRow | null,
  value: number | null,
  trackedField: string | null,
): { sample_count: number; tracked_field: string | null; running_mean: number | null; running_m2: number | null; last_value: number | null } {
  const baseHasNumeric =
    baseline !== null &&
    baseline.tracked_field !== null &&
    baseline.running_mean !== null &&
    baseline.running_m2 !== null;

  // If the caller switched tracked_field mid-stream (or finally supplied
  // one after a run of nulls), restart the running stats from this
  // sample rather than mixing incompatible distributions.
  const switched = trackedField !== null && baseHasNumeric && baseline!.tracked_field !== trackedField;

  if (trackedField === null || value === null) {
    return {
      sample_count: (baseline?.sample_count ?? 0) + 1,
      tracked_field: baseline?.tracked_field ?? null,
      running_mean: baseline?.running_mean ?? null,
      running_m2: baseline?.running_m2 ?? null,
      last_value: baseline?.last_value ?? null,
    };
  }

  if (!baseHasNumeric || switched) {
    return {
      sample_count: 1,
      tracked_field: trackedField,
      running_mean: value,
      running_m2: 0,
      last_value: value,
    };
  }

  const n = baseline!.sample_count + 1;
  const prevMean = baseline!.running_mean ?? 0;
  const delta = value - prevMean;
  const newMean = prevMean + delta / n;
  const delta2 = value - newMean;
  const newM2 = (baseline!.running_m2 ?? 0) + delta * delta2;

  return {
    sample_count: n,
    tracked_field: trackedField,
    running_mean: newMean,
    running_m2: newM2,
    last_value: value,
  };
}

// ---------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------

interface BaselineDbRow {
  experiment_id: string;
  subject: string;
  first_seen_at: string;
  last_seen_at: string;
  sample_count: number;
  tracked_field: string | null;
  running_mean: number | null;
  running_m2: number | null;
  last_value: number | null;
  last_verdict: string | null;
  consecutive_fails: number;
  updated_at: string;
}

export async function readBaseline(
  db: DatabaseAdapter,
  experimentId: string,
  subject: string,
): Promise<ObservationBaselineRow | null> {
  try {
    const { data } = await db
      .from<BaselineDbRow>('self_observation_baselines')
      .select('*')
      .eq('experiment_id', experimentId)
      .eq('subject', subject)
      .limit(1);
    const rows = (data ?? []) as BaselineDbRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Insert or update the baseline row for (experimentId, subject) with
 * the post-sample stats. Tolerates a missing table (migration not yet
 * applied, test DBs without it) by silently skipping — baselines are
 * advisory, not required.
 */
export async function writeBaseline(
  db: DatabaseAdapter,
  existing: ObservationBaselineRow | null,
  experimentId: string,
  subject: string,
  verdict: Verdict,
  now: string,
  trackedField: string | null,
  value: number | null,
  consecutiveFails: number,
): Promise<void> {
  const stats = welfordUpdate(existing, value, trackedField);
  try {
    if (!existing) {
      await db.from('self_observation_baselines').insert({
        experiment_id: experimentId,
        subject,
        first_seen_at: now,
        last_seen_at: now,
        sample_count: stats.sample_count,
        tracked_field: stats.tracked_field,
        running_mean: stats.running_mean,
        running_m2: stats.running_m2,
        last_value: stats.last_value,
        last_verdict: verdict,
        consecutive_fails: consecutiveFails,
        updated_at: now,
      });
      return;
    }
    await db
      .from('self_observation_baselines')
      .update({
        last_seen_at: now,
        sample_count: stats.sample_count,
        tracked_field: stats.tracked_field,
        running_mean: stats.running_mean,
        running_m2: stats.running_m2,
        last_value: stats.last_value,
        last_verdict: verdict,
        consecutive_fails: consecutiveFails,
        updated_at: now,
      })
      .eq('experiment_id', experimentId)
      .eq('subject', subject);
  } catch {
    // Baselines are advisory; never block the finding write on them.
  }
}

/**
 * End-to-end helper the findings-store calls right before insert:
 * reads the baseline, computes novelty, returns both the baseline
 * (for the post-insert update) and the injected `__novelty` stanza
 * the caller should merge into evidence.
 */
export async function applyNoveltyOnWrite(
  db: DatabaseAdapter,
  row: NewFindingRow,
): Promise<{ baseline: ObservationBaselineRow | null; novelty: NoveltyInfo; value: number | null; trackedField: string | null }> {
  const subject = row.subject ?? '';
  if (!subject) {
    return {
      baseline: null,
      novelty: {
        score: 0,
        reason: 'normal',
        detail: null,
        z_score: null,
        repeat_count: 0,
        consecutive_fails: 0,
      },
      value: null,
      trackedField: null,
    };
  }

  const baseline = await readBaseline(db, row.experimentId, subject);
  const novelty = computeNovelty(baseline, row);
  const evidence = (row.evidence ?? {}) as Record<string, unknown>;
  const trackedField = typeof evidence.__tracked_field === 'string'
    ? evidence.__tracked_field
    : null;
  const rawValue = trackedField ? evidence[trackedField] : undefined;
  const value = typeof rawValue === 'number' && Number.isFinite(rawValue)
    ? rawValue
    : null;

  return { baseline, novelty, value, trackedField };
}
