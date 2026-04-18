/**
 * Operator-facing snapshot of the autonomy stack (Phase 6.7
 * Deliverable C).
 *
 * `getConductorState` answers the question "what is the autonomy doing
 * right now?" with a single read against the existing director / inbox
 * tables. Cheap reads, permissive on missing data, no schema changes.
 *
 * Surfaces:
 *   - HTTP   GET /autonomy/status            (src/api/routes/autonomy-status.ts)
 *   - MCP    ohwow_autonomy_status            (src/mcp-server/tools/autonomy-status.ts)
 *
 * The snapshot is a structural object; renderers (TUI, dashboard, MCP
 * formatter) decide how to display it. Local-only this phase; cloud
 * rendering is a later concern.
 */
import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { CONDUCTOR_ENV_FLAG } from './conductor.js';
import {
  countOpenFounderInbox,
  listAnsweredUnresolvedFounderInbox,
  type ArcRecord,
  type PhaseReportRecord,
} from './director-persistence.js';
import type { Mode } from './types.js';

export interface ConductorOpenArc {
  arc_id: string;
  opened_at: string;
  thesis: string;
  mode_of_invocation: string;
  elapsed_minutes: number;
  budget: { max_phases: number; max_minutes: number; max_inbox_qs: number };
  phases_run: number;
  phases_remaining: number;
}

export interface ConductorRecentArc {
  arc_id: string;
  opened_at: string;
  closed_at: string;
  status: 'closed' | 'aborted';
  exit_reason: string;
  phases_run: number;
}

export interface ConductorRecentPhaseReport {
  phase_id: string;
  arc_id: string;
  mode: Mode;
  goal: string;
  status: string;
  trios: number;
  started_at: string;
  ended_at: string | null;
}

export interface ConductorStateSnapshot {
  workspace_id: string;
  flag_on: boolean;
  open_arcs: ConductorOpenArc[];
  recent_arcs: ConductorRecentArc[];
  recent_phase_reports: ConductorRecentPhaseReport[];
  open_inbox_count: number;
  answered_unresolved_inbox_count: number;
  failing_triggers_count: number;
  pending_approvals_count: number;
}

interface ArcRow {
  id: string;
  workspace_id: string;
  opened_at: string;
  closed_at: string | null;
  mode_of_invocation: string;
  thesis: string;
  status: string;
  budget_max_phases: number;
  budget_max_minutes: number;
  budget_max_inbox_qs: number;
  kill_on_pulse_regression: number;
  pulse_at_entry: string;
  pulse_at_close: string | null;
  exit_reason: string | null;
}

interface PhaseReportRow {
  id: string;
  arc_id: string;
  workspace_id: string;
  phase_id: string;
  mode: string;
  goal: string;
  status: string;
  trios_run: number;
  started_at: string;
  ended_at: string | null;
}

const RECENT_ARCS_LIMIT = 5;
const RECENT_PHASE_REPORTS_LIMIT = 10;

function parseIso(ts: string): number {
  const t = Date.parse(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? 0 : t;
}

function elapsedMinutesSince(iso: string, now: number): number {
  const t = parseIso(iso);
  if (!t) return 0;
  return Math.max(0, Math.round((now - t) / 60_000));
}

export async function getConductorState(
  db: DatabaseAdapter,
  workspace_id: string,
): Promise<ConductorStateSnapshot> {
  const flag_on = process.env[CONDUCTOR_ENV_FLAG] === '1';
  const now = Date.now();

  // Open arcs (typically zero or one, but we surface all so the
  // operator can spot a stuck state).
  let openArcsRaw: ArcRow[] = [];
  try {
    const { data } = await db
      .from<ArcRow>('director_arcs')
      .select()
      .eq('workspace_id', workspace_id)
      .eq('status', 'open')
      .order('opened_at', { ascending: false });
    openArcsRaw = data ?? [];
  } catch (err) {
    logger.warn(
      { workspace_id, err: (err as Error).message },
      'autonomy.state.open_arcs.read.failed',
    );
  }

  // Per-arc phase counts so we can compute phases_run / phases_remaining.
  const phaseCountByArc = new Map<string, number>();
  if (openArcsRaw.length > 0) {
    for (const a of openArcsRaw) {
      try {
        const { data } = await db
          .from<{ id: string }>('director_phase_reports')
          .select('id')
          .eq('arc_id', a.id);
        phaseCountByArc.set(a.id, (data ?? []).length);
      } catch {
        phaseCountByArc.set(a.id, 0);
      }
    }
  }

  const open_arcs: ConductorOpenArc[] = openArcsRaw.map((a) => {
    const phases_run = phaseCountByArc.get(a.id) ?? 0;
    return {
      arc_id: a.id,
      opened_at: a.opened_at,
      thesis: a.thesis,
      mode_of_invocation: a.mode_of_invocation,
      elapsed_minutes: elapsedMinutesSince(a.opened_at, now),
      budget: {
        max_phases: a.budget_max_phases,
        max_minutes: a.budget_max_minutes,
        max_inbox_qs: a.budget_max_inbox_qs,
      },
      phases_run,
      phases_remaining: Math.max(0, a.budget_max_phases - phases_run),
    };
  });

  // Recent CLOSED / ABORTED arcs (last N).
  let recentArcsRaw: ArcRow[] = [];
  try {
    const { data } = await db
      .from<ArcRow>('director_arcs')
      .select()
      .eq('workspace_id', workspace_id)
      .in('status', ['closed', 'aborted'])
      .order('closed_at', { ascending: false })
      .limit(RECENT_ARCS_LIMIT);
    recentArcsRaw = data ?? [];
  } catch (err) {
    logger.warn(
      { workspace_id, err: (err as Error).message },
      'autonomy.state.recent_arcs.read.failed',
    );
  }

  const recent_arcs: ConductorRecentArc[] = [];
  for (const a of recentArcsRaw) {
    let phases_run = 0;
    try {
      const { data } = await db
        .from<{ id: string }>('director_phase_reports')
        .select('id')
        .eq('arc_id', a.id);
      phases_run = (data ?? []).length;
    } catch {
      /* permissive */
    }
    recent_arcs.push({
      arc_id: a.id,
      opened_at: a.opened_at,
      closed_at: a.closed_at ?? '',
      status: (a.status === 'aborted' ? 'aborted' : 'closed') as
        | 'closed'
        | 'aborted',
      exit_reason: a.exit_reason ?? '',
      phases_run,
    });
  }

  // Recent phase reports across the workspace (last N, all arcs).
  let recentReportsRaw: PhaseReportRow[] = [];
  try {
    const { data } = await db
      .from<PhaseReportRow>('director_phase_reports')
      .select(
        'id, arc_id, workspace_id, phase_id, mode, goal, status, trios_run, started_at, ended_at',
      )
      .eq('workspace_id', workspace_id)
      .order('started_at', { ascending: false })
      .limit(RECENT_PHASE_REPORTS_LIMIT);
    recentReportsRaw = data ?? [];
  } catch (err) {
    logger.warn(
      { workspace_id, err: (err as Error).message },
      'autonomy.state.recent_phase_reports.read.failed',
    );
  }
  const recent_phase_reports: ConductorRecentPhaseReport[] =
    recentReportsRaw.map((r) => ({
      phase_id: r.phase_id,
      arc_id: r.arc_id,
      mode: r.mode as Mode,
      goal: r.goal,
      status: r.status,
      trios: r.trios_run,
      started_at: r.started_at,
      ended_at: r.ended_at,
    }));

  // Inbox counts.
  let open_inbox_count = 0;
  try {
    open_inbox_count = await countOpenFounderInbox(db, workspace_id);
  } catch {
    /* permissive */
  }
  let answered_unresolved_inbox_count = 0;
  try {
    const rows = await listAnsweredUnresolvedFounderInbox(db, workspace_id);
    answered_unresolved_inbox_count = rows.length;
  } catch {
    /* permissive */
  }

  // Pulse-side counts (cheap reads only — full pulse is the dry-run path).
  let failing_triggers_count = 0;
  try {
    const { data } = await db
      .from<{ id: string }>('local_triggers')
      .select('id')
      .gte('consecutive_failures', 3);
    failing_triggers_count = (data ?? []).length;
  } catch {
    /* permissive */
  }
  let pending_approvals_count = 0;
  try {
    const { data } = await db
      .from<{ id: string }>('agent_workforce_tasks')
      .select('id')
      .eq('workspace_id', workspace_id)
      .eq('status', 'needs_approval');
    pending_approvals_count = (data ?? []).length;
  } catch {
    /* permissive */
  }

  return {
    workspace_id,
    flag_on,
    open_arcs,
    recent_arcs,
    recent_phase_reports,
    open_inbox_count,
    answered_unresolved_inbox_count,
    failing_triggers_count,
    pending_approvals_count,
  };
}

// Re-export the persistence types callers may want to inspect.
export type { ArcRecord, PhaseReportRecord };
