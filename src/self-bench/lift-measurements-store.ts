/**
 * lift-measurements-store — persistence layer for Phase 5 credit assignment.
 *
 * One row per (commit_sha, kpi_id, horizon_hours). safeSelfCommit
 * inserts a baseline row immediately after a commit lands with an
 * Expected-Lift trailer. A scheduled LiftMeasurementExperiment picks
 * up rows whose measure_at has passed and post_at is null, reads
 * the KPI again, computes signed_lift, and closes the row with a
 * verdict.
 *
 * Tolerance for 'flat' vs 'moved_{right,wrong}' is tunable per KPI
 * but defaults to a half-unit of the KPI's natural resolution — a
 * $0.005 revenue change shouldn't count as "moved right" when the
 * bucket is cents.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';
import { getKpi, signedLift } from './kpi-registry.js';

export type ExpectedDirection = 'up' | 'down' | 'any';
export type LiftVerdict = 'moved_right' | 'moved_wrong' | 'flat' | 'unmeasured';

export interface ExpectedLift {
  /** KPI id in the registry. Rejected if not present. */
  kpiId: string;
  /** Direction the commit claims it will move the KPI. */
  direction: ExpectedDirection;
  /** Lookback window. One row per horizon; pick 6, 24, 168 typically. */
  horizonHours: number;
}

export interface LiftMeasurementRow {
  id: string;
  workspace_id: string;
  commit_sha: string;
  kpi_id: string;
  expected_direction: ExpectedDirection;
  horizon_hours: number;
  baseline_value: number | null;
  baseline_at: string;
  measure_at: string;
  post_value: number | null;
  post_at: string | null;
  signed_lift: number | null;
  verdict: LiftVerdict | null;
  source_experiment_id: string | null;
  created_at: string;
}

export interface InsertBaselineInput {
  workspaceId: string;
  commitSha: string;
  expected: ExpectedLift;
  baselineValue: number | null;
  /** ISO now. Exposed for determinism in tests. */
  baselineAt: string;
  /** Optional — which experiment authored the commit. */
  sourceExperimentId?: string | null;
}

/**
 * "Flat" tolerance per KPI unit. Below this absolute signed_lift the
 * verdict is 'flat' instead of moved_right / moved_wrong. Keeps noise
 * from the minimum-resolution bucket from being misread as movement.
 *
 * cents → 50  ($0.50)
 * count → 1   (one more/fewer row)
 * ratio → 0.02 (2 percentage points)
 */
const FLAT_TOLERANCE_BY_UNIT: Record<string, number> = {
  cents: 50,
  count: 1,
  ratio: 0.02,
};

function flatToleranceFor(kpiId: string): number {
  const def = getKpi(kpiId);
  if (!def) return 0;
  return FLAT_TOLERANCE_BY_UNIT[def.unit] ?? 0;
}

/**
 * Classify a signed_lift into a verdict given the kpi and expected
 * direction. `signed_lift` is already direction-normalized per the
 * KPI's higher_is_better (positive = moved right), but the caller's
 * *expected* direction may be 'down' to mean "we wanted this to go
 * down" — in that case a positive signed_lift against a
 * higher_is_better KPI is still "moved right," but for a commit that
 * claimed 'down' on a lower_is_better KPI, the semantics are the
 * same. The registry-level sign normalization handles both sides.
 *
 * `expected_direction='any'` means no direction was claimed — any
 * motion above the tolerance counts as right, below the negative
 * tolerance counts as wrong.
 */
export function verdictForLift(
  kpiId: string,
  lift: number | null,
  expected: ExpectedDirection,
): LiftVerdict {
  if (lift === null || !Number.isFinite(lift)) return 'unmeasured';
  const tol = flatToleranceFor(kpiId);
  if (Math.abs(lift) <= tol) return 'flat';
  if (expected === 'any') return lift > 0 ? 'moved_right' : 'moved_wrong';
  // 'up' / 'down' — the registry's signedLift already normalized the
  // direction, so positive means "moved in the higher_is_better
  // direction." If the caller expected 'down' on a higher_is_better
  // KPI they want *negative* raw lift, which signedLift flips to
  // positive. So here a positive lift always means "moved in the
  // direction the author expected" given they matched direction to
  // the KPI's semantics. We trust the author's direction to match
  // the KPI; a mismatch (expected 'up' on a lower_is_better KPI)
  // would surface as consistently 'moved_wrong' in the ledger and
  // is a data-cleanup signal rather than a silent correctness bug.
  return lift > 0 ? 'moved_right' : 'moved_wrong';
}

/**
 * Insert one baseline row per expected KPI × horizon. Returns the
 * number of rows inserted. Duplicate UNIQUE collisions are swallowed
 * so safeSelfCommit can retry without double-inserting.
 *
 * Validates that every kpiId exists in the registry. Unknown KPIs
 * are logged and skipped — the commit lands either way; we just
 * don't track an unmeasurable KPI.
 */
export async function insertBaseline(
  db: DatabaseAdapter,
  input: InsertBaselineInput,
): Promise<number> {
  const def = getKpi(input.expected.kpiId);
  if (!def) {
    logger.warn(
      { kpiId: input.expected.kpiId, commitSha: input.commitSha },
      '[lift-measurements] skip baseline — unknown kpi id',
    );
    return 0;
  }
  const baselineAtMs = Date.parse(input.baselineAt);
  if (!Number.isFinite(baselineAtMs)) {
    logger.warn(
      { baselineAt: input.baselineAt, commitSha: input.commitSha },
      '[lift-measurements] skip baseline — unparseable baseline_at',
    );
    return 0;
  }
  const measureAtIso = new Date(
    baselineAtMs + input.expected.horizonHours * 60 * 60 * 1000,
  ).toISOString();

  try {
    const { error } = await db.from('lift_measurements').insert({
      workspace_id: input.workspaceId,
      commit_sha: input.commitSha,
      kpi_id: input.expected.kpiId,
      expected_direction: input.expected.direction,
      horizon_hours: input.expected.horizonHours,
      baseline_value: input.baselineValue,
      baseline_at: input.baselineAt,
      measure_at: measureAtIso,
      source_experiment_id: input.sourceExperimentId ?? null,
    });
    if (error) {
      // UNIQUE collision on retry is expected; don't log it as fatal.
      const msg = error.message ?? '';
      if (/UNIQUE|duplicate/i.test(msg)) return 0;
      logger.warn(
        { err: msg, commitSha: input.commitSha, kpiId: input.expected.kpiId },
        '[lift-measurements] insert baseline failed',
      );
      return 0;
    }
    return 1;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : err,
        commitSha: input.commitSha,
        kpiId: input.expected.kpiId,
      },
      '[lift-measurements] insert baseline threw',
    );
    return 0;
  }
}

/**
 * Rows whose measure_at has passed and that haven't been closed yet.
 * The LiftMeasurementExperiment's probe loop calls this to find work.
 */
export async function listPendingMeasurements(
  db: DatabaseAdapter,
  workspaceId: string,
  nowIso: string,
  limit = 50,
): Promise<LiftMeasurementRow[]> {
  try {
    const { data } = await db
      .from<LiftMeasurementRow>('lift_measurements')
      .select('*')
      .eq('workspace_id', workspaceId)
      .is('post_at', null)
      .lte('measure_at', nowIso)
      .order('measure_at', { ascending: true })
      .limit(limit);
    return (data ?? []) as LiftMeasurementRow[];
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, workspaceId },
      '[lift-measurements] listPending failed',
    );
    return [];
  }
}

export interface CompleteMeasurementInput {
  id: string;
  postValue: number | null;
  postAt: string;
}

/**
 * Close a measurement row. Caller passes the post_value it read; this
 * helper computes signed_lift + verdict and UPDATEs the row.
 */
export async function completeMeasurement(
  db: DatabaseAdapter,
  row: LiftMeasurementRow,
  input: CompleteMeasurementInput,
): Promise<LiftVerdict> {
  const lift = signedLift(row.kpi_id, row.baseline_value, input.postValue);
  const verdict = verdictForLift(row.kpi_id, lift, row.expected_direction);
  try {
    const { error } = await db
      .from('lift_measurements')
      .update({
        post_value: input.postValue,
        post_at: input.postAt,
        signed_lift: lift,
        verdict,
      })
      .eq('id', input.id);
    if (error) {
      logger.warn(
        { err: error.message, id: input.id },
        '[lift-measurements] update failed',
      );
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, id: input.id },
      '[lift-measurements] update threw',
    );
  }
  return verdict;
}

/**
 * Summary used by the strategist / dashboard: count of verdicts in a
 * recent window. Aggregates across all KPIs + horizons. A healthy loop
 * shows moved_right > moved_wrong > flat by a comfortable margin.
 */
export async function summarizeRecentVerdicts(
  db: DatabaseAdapter,
  workspaceId: string,
  sinceIso: string,
): Promise<{ moved_right: number; moved_wrong: number; flat: number; unmeasured: number; total_closed: number }> {
  const empty = { moved_right: 0, moved_wrong: 0, flat: 0, unmeasured: 0, total_closed: 0 };
  try {
    const { data } = await db
      .from<{ verdict: LiftVerdict | null }>('lift_measurements')
      .select('verdict')
      .eq('workspace_id', workspaceId)
      .gte('post_at', sinceIso)
      .limit(10000);
    const rows = (data ?? []) as Array<{ verdict: LiftVerdict | null }>;
    const counts = { ...empty };
    for (const r of rows) {
      if (!r.verdict) continue;
      counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
      counts.total_closed += 1;
    }
    return counts;
  } catch {
    return empty;
  }
}
