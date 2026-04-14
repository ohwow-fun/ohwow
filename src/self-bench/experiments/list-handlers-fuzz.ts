/**
 * ListHandlersFuzzExperiment — wraps the E4 list-handler fuzz
 * (src/orchestrator/self-bench/fuzz-list-handlers.ts) as a scheduled
 * experiment so hidden-truncation bugs in list_* tools surface in
 * the findings ledger without a human running the test suite.
 *
 * The fuzz module is synchronous and takes a SqliteReader that
 * exposes a sync `.all(sql, params)` method. The runner hands us a
 * DatabaseAdapter (async, supabase-style). We bridge by pre-fetching
 * one workspace-scoped row set per tracked table up-front, then
 * passing a sync shim whose `.all` returns counts from that cache.
 * The shim is narrow on purpose — it only understands the exact
 * COUNT(*) query the fuzz runs, so we don't pretend to be a real
 * sqlite reader for arbitrary SQL.
 *
 * No intervene. A hidden-truncation finding is a code-level bug: a
 * handler needs a limit param + a total field or it needs to go
 * unbounded. The model and the operator both want to see it, but the
 * system can't patch it on its own.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import {
  LIST_HANDLER_PROBES,
  runListHandlerFuzz,
  type FuzzProbeResult,
  type SqliteReader,
} from '../../orchestrator/self-bench/fuzz-list-handlers.js';
import { logger } from '../../lib/logger.js';

interface FuzzFindingRow {
  tool: string;
  table: string;
  total_rows: number;
  effective_limit: number | null;
  verdict: string;
}

interface ListFuzzEvidence extends Record<string, unknown> {
  total_probes: number;
  active_count: number;
  latent_count: number;
  clean_count: number;
  active_findings: FuzzFindingRow[];
  latent_findings: FuzzFindingRow[];
}

function toFindingRow(r: FuzzProbeResult): FuzzFindingRow {
  return {
    tool: r.probe.tool,
    table: r.probe.table,
    total_rows: r.totalRows,
    effective_limit: r.effectiveLimit,
    verdict: r.verdict,
  };
}

export class ListHandlersFuzzExperiment implements Experiment {
  id = 'list-handlers-fuzz';
  name = 'list_* handler hidden-truncation fuzz';
  category = 'tool_reliability' as const;
  hypothesis =
    'Every list_* tool is either unbounded or returns {total, returned, limit, items} so the caller can tell whether a response is complete. No list_* handler silently truncates rows below its true backing-table count.';
  cadence = { everyMs: 15 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    // Pre-fetch workspace-scoped row counts for every table a probe
    // targets. The underlying fuzz only reads COUNT(*) — we satisfy
    // that via select('id').eq('workspace_id', …) and measure the
    // returned array length. Pulling ids is wasteful on very large
    // tables; in practice list_* tables max out at a few hundred
    // rows per workspace, which is fine on a 15-minute cadence.
    const counts = new Map<string, number>();
    const uniqueTables = Array.from(new Set(LIST_HANDLER_PROBES.map((p) => p.table)));
    for (const table of uniqueTables) {
      try {
        const { data } = await ctx.db
          .from(table)
          .select('id')
          .eq('workspace_id', ctx.workspaceId);
        counts.set(table, (data ?? []).length);
      } catch (err) {
        // Table may not exist in this workspace yet, or the adapter
        // may not expose it. Treat as zero rows so the fuzz returns
        // a 'clean' verdict for that probe rather than blowing up.
        logger.debug({ err, table }, '[list-handlers-fuzz] count fetch failed; treating as 0');
        counts.set(table, 0);
      }
    }

    const reader: SqliteReader = {
      all: (sql: string) => {
        const match = sql.match(/FROM\s+(\S+)\s+WHERE/);
        const table = match?.[1];
        const c = table ? counts.get(table) ?? 0 : 0;
        return [{ c }];
      },
    };

    const run = runListHandlerFuzz(reader, ctx.workspaceId);
    const active = run.results.filter((r) => r.severity === 'active').map(toFindingRow);
    const latent = run.results.filter((r) => r.severity === 'latent').map(toFindingRow);

    const evidence: ListFuzzEvidence = {
      total_probes: run.summary.totalProbes,
      active_count: run.summary.active,
      latent_count: run.summary.latent,
      clean_count: run.summary.clean,
      active_findings: active,
      latent_findings: latent,
    };

    const summary = run.summary.active === 0 && run.summary.latent === 0
      ? `${run.summary.totalProbes} list handler(s) clean`
      : `${run.summary.active} active truncation, ${run.summary.latent} latent, ${run.summary.clean} clean of ${run.summary.totalProbes}`;

    const subject = active.length > 0
      ? `list:${active[0].tool}`
      : latent.length > 0
        ? `list:${latent[0].tool}`
        : null;

    return { subject, summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ListFuzzEvidence;
    // Active = caller is being silently lied to right now (bounded
    // limit, no total field, rows exceed the cap). Even one is a
    // hard fail. Latent = same design smell with rows currently
    // under the cap — a warning so the ledger captures drift without
    // escalating while the bug is dormant.
    if (ev.active_count > 0) return 'fail';
    if (ev.latent_count > 0) return 'warning';
    return 'pass';
  }
}
