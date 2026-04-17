/**
 * LiftMeasurementExperiment — Phase 5 credit-assignment probe.
 *
 * Every tick, reads pending rows from lift_measurements (measure_at
 * has passed, post_at is still null) and closes them by re-reading
 * the KPI via the registry. Emits one finding per commit that a
 * closure landed on, aggregating all that commit's closed
 * measurements into a single narrative row so the strategist /
 * digest doesn't see 5 separate lines per autonomous commit.
 *
 * Verdict:
 *   pass    — nothing pending OR every closed measurement is
 *             moved_right / flat (loop is converging on KPIs)
 *   warning — at least one moved_wrong (the commit hurt the KPI
 *             it claimed to move)
 *   fail    — ≥3 moved_wrong in this tick (multiple commits in a
 *             row hurt their claimed KPIs — systemic signal)
 *
 * No intervene() — this probe is observational. The strategist /
 * future meta-ranker will consume the ledger rows to learn which
 * experiments / authors / ranker weights actually produce lifted
 * KPIs.
 */

import type {
  Experiment,
  ExperimentCadence,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import {
  completeMeasurement,
  listPendingMeasurements,
  summarizeRecentVerdicts,
  type LiftMeasurementRow,
  type LiftVerdict,
} from '../lift-measurements-store.js';
import { readKpi } from '../kpi-registry.js';

const CADENCE: ExperimentCadence = { everyMs: 10 * 60 * 1000, runOnBoot: true };
const PENDING_BATCH_LIMIT = 50;
const SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;
const SYSTEMIC_WRONG_THRESHOLD = 3;

export interface LiftMeasurementEvidence extends Record<string, unknown> {
  closed_this_tick: number;
  by_verdict: Record<LiftVerdict, number>;
  closed_commits: Array<{
    commit_sha: string;
    rows: Array<{
      kpi_id: string;
      horizon_hours: number;
      expected_direction: string;
      baseline_value: number | null;
      post_value: number | null;
      signed_lift: number | null;
      verdict: LiftVerdict;
    }>;
  }>;
  rolling_24h: {
    moved_right: number;
    moved_wrong: number;
    flat: number;
    unmeasured: number;
    total_closed: number;
  };
}

export class LiftMeasurementExperiment implements Experiment {
  readonly id = 'lift-measurement';
  readonly name = 'Autonomous-commit outcome lift measurement (Phase 5)';
  readonly category: ExperimentCategory = 'business_outcome';
  readonly hypothesis =
    'Every autonomous commit with an Expected-Lift trailer should actually move the claimed KPI at its horizon. Closing pending lift_measurements rows and tracking the moved_right / moved_wrong / flat distribution tells the loop whether it is producing value or just passing gates — the honest outcome signal the strategist needs to learn from.';
  readonly cadence = CADENCE;

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const nowIso = new Date().toISOString();
    const pending = await listPendingMeasurements(
      ctx.db,
      ctx.workspaceId,
      nowIso,
      PENDING_BATCH_LIMIT,
    );

    const closedByCommit = new Map<string, LiftMeasurementEvidence['closed_commits'][number]>();
    const byVerdict: Record<LiftVerdict, number> = {
      moved_right: 0,
      moved_wrong: 0,
      flat: 0,
      unmeasured: 0,
    };

    for (const row of pending) {
      const reading = await readKpi(row.kpi_id, {
        db: ctx.db,
        workspaceId: ctx.workspaceId,
      });
      const postValue = reading?.value ?? null;
      const verdict = await completeMeasurement(ctx.db, row, {
        id: row.id,
        postValue,
        postAt: nowIso,
      });
      byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1;

      const signedLiftValue =
        postValue !== null && row.baseline_value !== null
          ? (row.expected_direction === 'down' ? -(postValue - row.baseline_value) : postValue - row.baseline_value)
          : null;

      const summary = closedByCommit.get(row.commit_sha) ?? {
        commit_sha: row.commit_sha,
        rows: [],
      };
      summary.rows.push({
        kpi_id: row.kpi_id,
        horizon_hours: row.horizon_hours,
        expected_direction: row.expected_direction,
        baseline_value: row.baseline_value,
        post_value: postValue,
        signed_lift: signedLiftValue,
        verdict,
      });
      closedByCommit.set(row.commit_sha, summary);
    }

    const rolling = await summarizeRecentVerdicts(
      ctx.db,
      ctx.workspaceId,
      new Date(Date.now() - SUMMARY_WINDOW_MS).toISOString(),
    );

    const evidence: LiftMeasurementEvidence = {
      closed_this_tick: pending.length,
      by_verdict: byVerdict,
      closed_commits: [...closedByCommit.values()],
      rolling_24h: rolling,
    };

    const summary = [
      `Result: closed ${pending.length} lift_measurement row(s) this tick (moved_right=${byVerdict.moved_right}, moved_wrong=${byVerdict.moved_wrong}, flat=${byVerdict.flat}, unmeasured=${byVerdict.unmeasured}). 24h rolling: ${rolling.moved_right}↑ / ${rolling.moved_wrong}↓ / ${rolling.flat}≈ of ${rolling.total_closed} closed.`,
      `Threshold: warn when any moved_wrong closed this tick; fail when ≥${SYSTEMIC_WRONG_THRESHOLD} moved_wrong in one tick (systemic regression signal).`,
      pending.length === 0
        ? 'Conclusion: no measurements due; loop is either idle or all baselines still ripening.'
        : byVerdict.moved_wrong >= SYSTEMIC_WRONG_THRESHOLD
          ? `Conclusion: ${byVerdict.moved_wrong} commits in this batch hurt their claimed KPIs. Ranker weights or author targeting need review.`
          : byVerdict.moved_wrong > 0
            ? `Conclusion: ${byVerdict.moved_wrong} commit(s) moved the wrong way this tick; acceptable as noise but the strategist should watch the rolling distribution.`
            : `Conclusion: closed ${pending.length} measurement(s) cleanly; loop is producing lift or staying flat.`,
    ].join('\n');

    return {
      subject: `lift:${nowIso.slice(0, 13)}`,
      summary,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as LiftMeasurementEvidence;
    if (ev.closed_this_tick === 0) return 'pass';
    if (ev.by_verdict.moved_wrong >= SYSTEMIC_WRONG_THRESHOLD) return 'fail';
    if (ev.by_verdict.moved_wrong > 0) return 'warning';
    return 'pass';
  }
}
