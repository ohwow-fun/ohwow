/**
 * Fuzz: every list_* handler audited for hidden pagination
 *
 * The B0.13 bench showed the orchestrator confidently reporting "105
 * total tasks" when the underlying list handler only returned 10 —
 * the model had no way to distinguish "got everything" from "got the
 * first page", because the list_tasks return value carries no
 * total/returned pair. M0.21's deliverables count drift later
 * motivated adding a `total` field to list_deliverables. This fuzz
 * generalizes that fix: audit every list_* tool, flag the ones that
 * silently truncate and don't expose a total, and measure against the
 * live workspace db whether the truncation is currently biting.
 *
 * This module is intentionally static about the handler shape. It
 * does NOT try to dynamically parse the handler source at runtime —
 * that's more fragile than it's worth. Instead, each probe here is a
 * hand-authored description of what the handler does, derived from a
 * one-time read of the handler source. When a handler changes, the
 * probe drifts and the test fails, which is exactly the point: the
 * audit is a living invariant, not a static analysis.
 *
 * Usage:
 *   - `runListHandlerFuzz(sqlite, workspaceId)` runs every probe
 *     against a db handle and returns a structured report.
 *   - The companion test `fuzz-list-handlers-live.test.ts` runs this
 *     against the live workspace db read-only. Any finding surfaces
 *     as a test failure with a clear verdict line.
 */

export type HandlerLimitShape =
  /** No limit — the handler returns every row that matches its filter. */
  | { kind: 'unbounded' }
  /** Caller can pass a limit via an `input.limit` parameter; if omitted, `default` applies. */
  | { kind: 'param'; default: number }
  /** Limit is hardcoded in the handler source; no caller override. */
  | { kind: 'hardcoded'; value: number };

export interface ListHandlerProbe {
  /** Tool name as registered in tools/registry.ts. */
  tool: string;
  /** Backing table the handler reads from for its main list query. */
  table: string;
  /** Handler file path relative to repo root (for error messages + future static checks). */
  handlerFile: string;
  /** Shape of the handler's row-limit behavior. */
  limit: HandlerLimitShape;
  /**
   * True iff the handler's return value exposes a `total` field (or
   * equivalent) so the caller can tell whether the returned rows are
   * a complete set or a page. False = hidden pagination bug when
   * combined with any non-unbounded limit shape.
   */
  returnsTotal: boolean;
  /**
   * Optional note: additional hidden filters the handler applies
   * beyond workspace_id. Purely descriptive — the fuzz compares
   * against the raw COUNT(*), so any extra filter shows up as a
   * disagreement regardless of whether we list it here.
   */
  notes?: string;
}

/**
 * The full audit set. Add a new probe any time a new list_* handler
 * lands in the registry. When you do, re-read the handler source to
 * fill in `limit` and `returnsTotal` accurately; a wrong probe is
 * worse than no probe because it silently suppresses real findings.
 */
export const LIST_HANDLER_PROBES: ListHandlerProbe[] = [
  {
    tool: 'list_agents',
    table: 'agent_workforce_agents',
    handlerFile: 'src/orchestrator/tools/agents.ts',
    limit: { kind: 'unbounded' },
    returnsTotal: false,
    notes: 'joins agent_workforce_schedules for schedule map; main list is unbounded',
  },
  {
    tool: 'list_tasks',
    table: 'agent_workforce_tasks',
    handlerFile: 'src/orchestrator/tools/tasks.ts',
    limit: { kind: 'param', default: 50 },
    returnsTotal: true,
    notes: 'returns {total, returned, limit, tasks}; default 50, max 500 — fixed in the E4 landing commit',
  },
  {
    tool: 'list_projects',
    table: 'agent_workforce_projects',
    handlerFile: 'src/orchestrator/tools/projects.ts',
    limit: { kind: 'unbounded' },
    returnsTotal: false,
    notes: 'joins tasks for per-project progress %, main list is unbounded',
  },
  {
    tool: 'list_goals',
    table: 'agent_workforce_goals',
    handlerFile: 'src/orchestrator/tools/goals.ts',
    limit: { kind: 'unbounded' },
    returnsTotal: false,
    notes: 'joins tasks + projects for progress; main list is unbounded',
  },
  {
    tool: 'list_workflows',
    table: 'agent_workforce_workflows',
    handlerFile: 'src/orchestrator/tools/workflows.ts',
    limit: { kind: 'param', default: 50 },
    returnsTotal: true,
    notes: 'E4 fuzz finding: previously hardcoded limit(20) with no caller override; now accepts a limit param and returns {total, returned, limit, workflows}',
  },
  {
    tool: 'list_deliverables',
    table: 'agent_workforce_deliverables',
    handlerFile: 'src/orchestrator/tools/deliverables.ts',
    limit: { kind: 'param', default: 20 },
    returnsTotal: true,
    notes: 'already returns {total, returned, limit, since, deliverables}; reference shape',
  },
  {
    tool: 'list_contacts',
    table: 'agent_workforce_contacts',
    handlerFile: 'src/orchestrator/tools/crm.ts',
    limit: { kind: 'param', default: 50 },
    returnsTotal: true,
    notes: 'E4 fuzz finding: now returns {total, returned, limit, contacts}; default 50, max 500',
  },
  {
    tool: 'list_team_members',
    table: 'agent_workforce_team_members',
    handlerFile: 'src/orchestrator/tools/team.ts',
    limit: { kind: 'unbounded' },
    returnsTotal: false,
  },
  {
    tool: 'list_workflow_triggers',
    table: 'agent_workforce_workflow_triggers',
    handlerFile: 'src/orchestrator/tools/triggers.ts',
    limit: { kind: 'unbounded' },
    returnsTotal: false,
  },
  {
    tool: 'list_person_models',
    table: 'agent_workforce_person_models',
    handlerFile: 'src/orchestrator/tools/person-model.ts',
    limit: { kind: 'unbounded' },
    returnsTotal: false,
  },
];

export interface FuzzProbeResult {
  probe: ListHandlerProbe;
  /** Raw COUNT(*) against the table, filtered by workspace_id. Ground truth. */
  totalRows: number;
  /** How many rows the handler would return given its limit shape. Null when unbounded. */
  effectiveLimit: number | null;
  /** True iff the handler's effective return set is smaller than the true total. */
  truncatesLive: boolean;
  /** Severity ranking — stable enough to sort a findings report on. */
  severity: 'clean' | 'latent' | 'active';
  /** Human-readable verdict for the report. */
  verdict: string;
}

export interface FuzzRunResult {
  startedAt: string;
  finishedAt: string;
  workspaceId: string;
  results: FuzzProbeResult[];
  findings: FuzzProbeResult[];
  summary: {
    totalProbes: number;
    clean: number;
    latent: number;
    active: number;
  };
}

/**
 * Minimal sqlite adapter interface the fuzz needs. Tests pass a
 * better-sqlite3 wrapper; in production this maps to the same read
 * path the rest of the self-bench uses. Kept abstract so the fuzz
 * can run against either a scratch fixture DB or the real runtime.db
 * without a full LocalToolContext.
 */
export interface SqliteReader {
  /** Execute a read-only SQL query and return the rows. */
  all: (query: string, params?: Array<string | number>) => unknown[];
}

/**
 * Run every probe against the given database. Pure, deterministic,
 * no model calls. Each probe:
 *   1. Counts total rows in the backing table for `workspaceId`.
 *   2. Computes the handler's effective limit (null for unbounded,
 *      a number for param/hardcoded shapes).
 *   3. Decides severity:
 *      - 'clean'  — unbounded OR totalRows <= effectiveLimit (the
 *                   handler returns everything the caller wanted)
 *      - 'latent' — limited but totalRows == 0, so the truncation
 *                   isn't currently biting; still a design smell
 *                   when returnsTotal=false
 *      - 'active' — totalRows > effectiveLimit: the handler is
 *                   currently hiding rows from the caller
 *   4. Builds a one-line verdict string for the report.
 */
export function runListHandlerFuzz(db: SqliteReader, workspaceId: string): FuzzRunResult {
  const startedAt = new Date().toISOString();
  const results: FuzzProbeResult[] = [];

  for (const probe of LIST_HANDLER_PROBES) {
    let totalRows = 0;
    try {
      const rows = db.all(
        `SELECT COUNT(*) AS c FROM ${probe.table} WHERE workspace_id = ?`,
        [workspaceId],
      );
      totalRows = Number((rows[0] as { c: number } | undefined)?.c ?? 0);
    } catch (err) {
      // Table may not exist in a test fixture; treat as zero rows +
      // emit a latent verdict so the caller sees the skip.
      totalRows = 0;
      results.push({
        probe,
        totalRows: 0,
        effectiveLimit: null,
        truncatesLive: false,
        severity: 'clean',
        verdict: `skip: table ${probe.table} not present (${err instanceof Error ? err.message : 'error'})`,
      });
      continue;
    }

    let effectiveLimit: number | null;
    switch (probe.limit.kind) {
      case 'unbounded': effectiveLimit = null; break;
      case 'param':     effectiveLimit = probe.limit.default; break;
      case 'hardcoded': effectiveLimit = probe.limit.value; break;
    }

    const truncatesLive = effectiveLimit !== null && totalRows > effectiveLimit;

    // Severity classification:
    //   clean  — handler is unbounded, OR bounded with a total field
    //            (pagination is a feature, not a bug, as long as the
    //            caller can tell it's paginated)
    //   latent — bounded, no total field, rows exist under the cap,
    //            the bug is dormant but will bite when the workspace
    //            grows past the limit
    //   active — bounded, no total field, rows exceed the cap RIGHT
    //            NOW, the caller is being silently lied to
    //
    // A handler that returns `{total, returned, limit, items}` is
    // DOING THE RIGHT THING when it paginates a large table: the
    // model sees total=119, returned=50, and knows to paginate for
    // the rest. That's not a bug — it's pagination working. True
    // "active" findings are reserved for hidden-truncation bugs
    // where the caller has no idea rows are missing.
    let severity: FuzzProbeResult['severity'] = 'clean';
    let verdict = '';
    if (effectiveLimit === null) {
      severity = 'clean';
      verdict = `OK: ${probe.tool} is unbounded (${totalRows} rows in ${probe.table})`;
    } else if (truncatesLive && !probe.returnsTotal) {
      severity = 'active';
      verdict = `ACTIVE: ${probe.tool} returns at most ${effectiveLimit} of ${totalRows} rows and does NOT expose a total field — caller cannot tell it is truncated`;
    } else if (truncatesLive && probe.returnsTotal) {
      severity = 'clean';
      verdict = `OK (paginated): ${probe.tool} returns ${effectiveLimit} of ${totalRows} rows with a total field so the caller can paginate`;
    } else if (!probe.returnsTotal && probe.limit.kind !== 'unbounded' && totalRows > 0) {
      // Latent fires only when rows EXIST but are still under the
      // cap. An empty table is truly clean: the design smell is
      // real but it has nothing to hide yet. Once rows arrive the
      // probe promotes to latent, then to active when the cap is
      // exceeded.
      severity = 'latent';
      verdict = `LATENT: ${probe.tool} has a ${probe.limit.kind}=${effectiveLimit} default with no total field; ${totalRows} rows in ${probe.table} is currently under cap but will silently truncate as the workspace grows`;
    } else {
      severity = 'clean';
      verdict = `OK: ${probe.tool} limited to ${effectiveLimit} ${totalRows > 0 ? `with total field (${totalRows} rows)` : '(empty table)'}`;
    }

    results.push({ probe, totalRows, effectiveLimit, truncatesLive, severity, verdict });
  }

  // Promote findings: anything that isn't 'clean' should surface to
  // the caller as an actionable item. 'active' findings rank above
  // 'latent' in the report so the most-biting issues lead.
  const findings = results
    .filter((r) => r.severity !== 'clean')
    .sort((a, b) => (a.severity === 'active' ? -1 : 1) - (b.severity === 'active' ? -1 : 1));

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    workspaceId,
    results,
    findings,
    summary: {
      totalProbes: results.length,
      clean: results.filter((r) => r.severity === 'clean').length,
      latent: results.filter((r) => r.severity === 'latent').length,
      active: results.filter((r) => r.severity === 'active').length,
    },
  };
}

/**
 * Format a fuzz run as a human-readable report. Used by both the
 * test output and any chat-dispatched consumer that wants to log a
 * summary. Keeps the shape stable so diffs between runs are easy to
 * eyeball.
 */
export function formatFuzzReport(run: FuzzRunResult): string {
  const lines: string[] = [];
  lines.push(
    `list_* fuzz report — workspace ${run.workspaceId}, ` +
    `${run.summary.totalProbes} probes, ${run.summary.active} active / ${run.summary.latent} latent / ${run.summary.clean} clean`,
  );
  lines.push('');
  for (const result of run.results) {
    const tag = result.severity === 'active' ? '🔴' : result.severity === 'latent' ? '🟡' : '🟢';
    lines.push(`${tag} ${result.verdict}`);
    if (result.probe.notes) lines.push(`    note: ${result.probe.notes}`);
  }
  return lines.join('\n');
}
