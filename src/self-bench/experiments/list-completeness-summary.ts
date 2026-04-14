/**
 * ListCompletenessSummaryExperiment — Phase 8-A.3
 *
 * Meta-experiment that synthesizes findings from the `list-handlers-fuzz`
 * experiment into a single business-facing signal:
 *
 *   "How many list handlers have had active truncation findings
 *    in the last 7 days, and are any of them still failing?"
 *
 * Rather than re-running the fuzz directly, this experiment reads
 * the ledger and reports on what the fuzz has been seeing. This is
 * intentionally a meta-observation layer: the fuzz accumulates
 * fine-grained probe results; this experiment turns them into an
 * operator-visible health summary.
 *
 * Emits:
 *   pass    — no active truncation findings in the last 7 days
 *   warning — active or latent truncation findings exist but no recent fail
 *   fail    — list-handlers-fuzz has emitted a fail verdict in the last 24h
 *
 * Cadence: 1 hour. The fuzz runs on its own cadence; this just reads
 * the ledger and surfaces a digest.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

const SUMMARY_WINDOW_DAYS = 7;
const RECENT_FAIL_WINDOW_HOURS = 24;
const SOURCE_EXPERIMENT_ID = 'list-handlers-fuzz';
/** How many recent findings to scan from the fuzz experiment. */
const SCAN_LIMIT = 200;

interface TruncationHandler {
  tool: string;
  table: string;
  verdict: string;
  ran_at: string;
}

interface ListCompletenessSummaryEvidence extends Record<string, unknown> {
  window_days: number;
  total_fuzz_findings_scanned: number;
  handlers_with_active_truncation: TruncationHandler[];
  handlers_with_latent_truncation: TruncationHandler[];
  recent_fail_within_24h: boolean;
  most_recent_fuzz_ran_at: string | null;
}

export class ListCompletenessSummaryExperiment implements Experiment {
  id = 'list-completeness-summary';
  name = 'List handler completeness digest';
  category = 'handler_audit' as const;
  hypothesis =
    'The list-handlers-fuzz experiment surfaces all hidden-truncation bugs in list_* tools within 7 days. This meta-probe surfaces a business-facing digest of those findings to reduce operator noise from individual fuzz runs.';
  cadence = { everyMs: 60 * 60 * 1000, runOnBoot: false };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const windowStart = new Date(
      Date.now() - SUMMARY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const recentFailStart = new Date(
      Date.now() - RECENT_FAIL_WINDOW_HOURS * 60 * 60 * 1000,
    ).toISOString();

    // Read the fuzz experiment's recent findings via the context helper
    const fuzzFindings = await ctx
      .recentFindings(SOURCE_EXPERIMENT_ID, SCAN_LIMIT)
      .catch(() => [] as Finding[]);

    // Filter to those within the summary window
    const windowFindings = fuzzFindings.filter((f) => f.ranAt >= windowStart);

    if (windowFindings.length === 0) {
      const evidence: ListCompletenessSummaryEvidence = {
        window_days: SUMMARY_WINDOW_DAYS,
        total_fuzz_findings_scanned: 0,
        handlers_with_active_truncation: [],
        handlers_with_latent_truncation: [],
        recent_fail_within_24h: false,
        most_recent_fuzz_ran_at: null,
      };
      return {
        subject: null,
        summary: `no list-handlers-fuzz findings in the last ${SUMMARY_WINDOW_DAYS}d`,
        evidence,
      };
    }

    const mostRecentFuzzRanAt = windowFindings[0].ranAt; // sorted newest-first

    // From each finding row, extract the active/latent handler breakdowns.
    // The fuzz evidence shape is { active_findings: FuzzFindingRow[], latent_findings: FuzzFindingRow[], ... }
    const activeHandlers = new Map<string, TruncationHandler>();
    const latentHandlers = new Map<string, TruncationHandler>();
    let recentFailWithin24h = false;

    for (const finding of windowFindings) {
      if (finding.ranAt >= recentFailStart && finding.verdict === 'fail') {
        recentFailWithin24h = true;
      }

      const ev = finding.evidence as {
        active_findings?: Array<{ tool: string; table: string; verdict: string }>;
        latent_findings?: Array<{ tool: string; table: string; verdict: string }>;
      };

      for (const af of ev.active_findings ?? []) {
        const key = `${af.tool}:${af.table}`;
        if (!activeHandlers.has(key)) {
          activeHandlers.set(key, {
            tool: af.tool,
            table: af.table,
            verdict: af.verdict,
            ran_at: finding.ranAt,
          });
        }
      }

      for (const lf of ev.latent_findings ?? []) {
        const key = `${lf.tool}:${lf.table}`;
        if (!latentHandlers.has(key) && !activeHandlers.has(key)) {
          latentHandlers.set(key, {
            tool: lf.tool,
            table: lf.table,
            verdict: lf.verdict,
            ran_at: finding.ranAt,
          });
        }
      }
    }

    const active = Array.from(activeHandlers.values());
    const latent = Array.from(latentHandlers.values());
    const totalIssues = active.length + latent.length;

    const evidence: ListCompletenessSummaryEvidence = {
      window_days: SUMMARY_WINDOW_DAYS,
      total_fuzz_findings_scanned: windowFindings.length,
      handlers_with_active_truncation: active,
      handlers_with_latent_truncation: latent,
      recent_fail_within_24h: recentFailWithin24h,
      most_recent_fuzz_ran_at: mostRecentFuzzRanAt,
    };

    const summary =
      totalIssues === 0
        ? `list handlers clean over ${SUMMARY_WINDOW_DAYS}d (${windowFindings.length} fuzz runs reviewed)`
        : `${active.length} active + ${latent.length} latent truncation handler(s) in ${SUMMARY_WINDOW_DAYS}d window`;

    return {
      subject: active.length > 0 ? active[0].tool : null,
      summary,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ListCompletenessSummaryEvidence;

    if (ev.total_fuzz_findings_scanned === 0) return 'pass';
    if (ev.recent_fail_within_24h) return 'fail';
    if (
      ev.handlers_with_active_truncation.length > 0 ||
      ev.handlers_with_latent_truncation.length > 0
    )
      return 'warning';

    return 'pass';
  }
}
