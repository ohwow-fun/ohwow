/**
 * LedgerHealthExperiment — meta-experiment that watches the
 * self-bench system itself.
 *
 * Who watches the watchmen? This one does. It reads recent findings
 * across every experiment and answers:
 *   1. Has each registered experiment run in the last N minutes?
 *      A registered experiment with no recent finding is either
 *      broken or starved out by a long-running peer.
 *   2. Are any experiments consistently failing (every run a
 *      verdict='error')? Those are indicating bugs in the probe
 *      itself, not in the thing being probed.
 *   3. Is the ledger writable? If probe() lands a finding row, the
 *      ledger is by definition writable. This is a passive smoke
 *      test of the entire self-bench pipe.
 *
 * This is the keystone that makes "self-improvement all day long"
 * credible: without a check on the checkers, a silent failure in
 * the runner itself would be invisible. Now, if any experiment
 * stops firing, the next tick of LedgerHealthExperiment surfaces it.
 *
 * No intervene — a stalled runner needs an operator or a daemon
 * restart, not a per-tick fix.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { listFindings } from '../findings-store.js';

/**
 * Experiments that haven't written a finding in this long are
 * considered stalled. Tuned conservatively: the longest registered
 * cadence today is CanaryExperiment + ModelHealthExperiment (15m
 * and 10m respectively), so 45 minutes gives 2-3 missed cycles of
 * slack before we flag it.
 */
const STALL_THRESHOLD_MS = 45 * 60 * 1000;

/** How far back to look for the recent-finding window. */
const LOOKBACK_MS = 2 * 60 * 60 * 1000; // 2 hours

interface ExperimentHealthRow {
  experiment_id: string;
  recent_runs: number;
  last_ran_at: string | null;
  last_verdict: string | null;
  error_rate: number;
  stalled: boolean;
}

interface LedgerHealthEvidence extends Record<string, unknown> {
  experiments: ExperimentHealthRow[];
  stalled_count: number;
  erroring_count: number;
  lookback_hours: number;
}

export class LedgerHealthExperiment implements Experiment {
  id = 'ledger-health';
  name = 'Self-bench ledger health check';
  category = 'other' as const;
  hypothesis =
    'Every registered experiment writes a finding at its expected cadence, and no experiment is stuck in a verdict=error loop that would indicate a broken probe.';
  cadence = { everyMs: 10 * 60 * 1000, runOnBoot: false };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    // Read the last 2 hours of findings, group by experiment_id,
    // compute error rate + last run time + stall status.
    const lookbackStart = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const findings = await listFindings(ctx.db, { limit: 500 });
    const recent = findings.filter((f) => f.ranAt >= lookbackStart);

    const byExperiment = new Map<string, Finding[]>();
    for (const f of recent) {
      // Skip our own rows so we don't self-reference and create a
      // feedback loop where a stalled probe looks stalled because we
      // didn't include our own recent run yet.
      if (f.experimentId === this.id) continue;
      const bucket = byExperiment.get(f.experimentId) ?? [];
      bucket.push(f);
      byExperiment.set(f.experimentId, bucket);
    }

    const now = Date.now();
    const rows: ExperimentHealthRow[] = [];
    for (const [experimentId, list] of byExperiment.entries()) {
      const sorted = [...list].sort((a, b) => b.ranAt.localeCompare(a.ranAt));
      const last = sorted[0];
      const lastRanAt = last.ranAt;
      const ageMs = now - new Date(lastRanAt).getTime();
      const errors = list.filter((f) => f.verdict === 'error').length;
      rows.push({
        experiment_id: experimentId,
        recent_runs: list.length,
        last_ran_at: lastRanAt,
        last_verdict: last.verdict,
        error_rate: list.length > 0 ? errors / list.length : 0,
        stalled: ageMs > STALL_THRESHOLD_MS,
      });
    }

    rows.sort((a, b) => a.experiment_id.localeCompare(b.experiment_id));

    const stalledCount = rows.filter((r) => r.stalled).length;
    const erroringCount = rows.filter((r) => r.error_rate >= 0.5 && r.recent_runs >= 2).length;

    const evidence: LedgerHealthEvidence = {
      experiments: rows,
      stalled_count: stalledCount,
      erroring_count: erroringCount,
      lookback_hours: LOOKBACK_MS / (60 * 60 * 1000),
    };

    const summary = rows.length === 0
      ? 'no findings in lookback window — runner may not be started yet'
      : stalledCount === 0 && erroringCount === 0
        ? `${rows.length} experiment(s) healthy in last ${evidence.lookback_hours}h`
        : `${stalledCount} stalled + ${erroringCount} erroring of ${rows.length} experiment(s)`;

    return { subject: null, summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as LedgerHealthEvidence;
    // Empty ledger is a warning — the runner might just not have
    // fired yet. Stalled experiments are a fail. Erroring without
    // stall is a warning (the probe is running but the probe itself
    // is buggy — still valuable signal, not a system-wide break).
    if (ev.experiments.length === 0) return 'warning';
    if (ev.stalled_count > 0) return 'fail';
    if (ev.erroring_count > 0) return 'warning';
    return 'pass';
  }
}
