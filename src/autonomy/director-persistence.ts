/**
 * Director-tier persistence (autonomy arc Phase 4).
 *
 * Typed wrappers over the DatabaseAdapter for the three new tables in
 * migration 144:
 *   * director_arcs
 *   * director_phase_reports
 *   * founder_inbox
 *
 * Same conventions as Phase 3's `persistence.ts`:
 *   - JSON columns are stringified on write and accepted as either
 *     strings or already-parsed shapes on read.
 *   - The Director / orchestrator above never reaches into raw rows;
 *     they consume the `*Record` shapes exported here.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { Mode } from './types.js';

// ----------------------------------------------------------------------------
// Public record shapes
// ----------------------------------------------------------------------------

export type ArcStatus = 'open' | 'closed' | 'aborted';
export type ArcExitReason =
  | 'budget'
  | 'budget-exceeded'
  | 'nothing-queued'
  | 'pulse-ko'
  | 'founder-returned';

export interface PulseSnapshot {
  /** Monthly recurring revenue, cents. */
  mrr_cents?: number;
  /** Count of contacts in pipeline (qualified or further). */
  pipeline_count?: number;
  /** Triggers tripping the watchdog's consecutive-failure threshold. */
  failing_triggers?: number;
  /** Tasks awaiting the founder's approval. */
  pending_approvals?: number;
  /** ISO timestamp of when the snapshot was taken. */
  ts: string;
  /** Free-form extra fields a future pulse reader can carry through. */
  [extra: string]: unknown;
}

export interface ArcRecord {
  id: string;
  workspace_id: string;
  opened_at: string;
  closed_at: string | null;
  mode_of_invocation: 'autonomous' | 'founder-initiated' | 'loop-tick';
  thesis: string;
  status: ArcStatus;
  budget_max_phases: number;
  budget_max_minutes: number;
  budget_max_inbox_qs: number;
  kill_on_pulse_regression: boolean;
  pulse_at_entry: PulseSnapshot;
  pulse_at_close: PulseSnapshot | null;
  exit_reason: ArcExitReason | null;
}

export type PhaseReportStatus =
  | 'queued'
  | 'in-flight'
  | 'phase-closed'
  | 'phase-partial'
  | 'phase-blocked-on-founder'
  | 'phase-aborted'
  | 'rolled-back';

export interface PhaseReportRecord {
  id: string;
  arc_id: string;
  workspace_id: string;
  phase_id: string;
  mode: Mode;
  goal: string;
  status: PhaseReportStatus;
  trios_run: number;
  runtime_sha_start: string | null;
  runtime_sha_end: string | null;
  cloud_sha_start: string | null;
  cloud_sha_end: string | null;
  delta_pulse_json: Record<string, unknown> | null;
  delta_ledger: string | null;
  inbox_added: string | null;
  remaining_scope: string | null;
  next_phase_recommendation: string | null;
  cost_trios: number | null;
  cost_minutes: number | null;
  cost_llm_cents: number | null;
  raw_report: string | null;
  started_at: string;
  ended_at: string | null;
}

export type FounderInboxStatus = 'open' | 'answered' | 'resolved' | 'expired';

export interface FounderInboxOption {
  label: string;
  text: string;
}

export interface FounderInboxRecord {
  id: string;
  workspace_id: string;
  arc_id: string | null;
  phase_id: string | null;
  mode: string;
  blocker: string;
  context: string;
  options: FounderInboxOption[];
  recommended: string | null;
  screenshot_path: string | null;
  asked_at: string;
  answered_at: string | null;
  answer: string | null;
  status: FounderInboxStatus;
}

// ----------------------------------------------------------------------------
// Row shapes (raw SQLite)
// ----------------------------------------------------------------------------

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
  runtime_sha_start: string | null;
  runtime_sha_end: string | null;
  cloud_sha_start: string | null;
  cloud_sha_end: string | null;
  delta_pulse_json: string | null;
  delta_ledger: string | null;
  inbox_added: string | null;
  remaining_scope: string | null;
  next_phase_recommendation: string | null;
  cost_trios: number | null;
  cost_minutes: number | null;
  cost_llm_cents: number | null;
  raw_report: string | null;
  started_at: string;
  ended_at: string | null;
}

interface FounderInboxRow {
  id: string;
  workspace_id: string;
  arc_id: string | null;
  phase_id: string | null;
  mode: string;
  blocker: string;
  context: string;
  options_json: string;
  recommended: string | null;
  screenshot_path: string | null;
  asked_at: string;
  answered_at: string | null;
  answer: string | null;
  status: string;
}

// ----------------------------------------------------------------------------
// JSON helpers (write-stringify, read-accept-both)
// ----------------------------------------------------------------------------

function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

function rowToArc(row: ArcRow): ArcRecord {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    mode_of_invocation: row.mode_of_invocation as ArcRecord['mode_of_invocation'],
    thesis: row.thesis,
    status: row.status as ArcStatus,
    budget_max_phases: row.budget_max_phases,
    budget_max_minutes: row.budget_max_minutes,
    budget_max_inbox_qs: row.budget_max_inbox_qs,
    kill_on_pulse_regression: row.kill_on_pulse_regression === 1,
    pulse_at_entry: parseJsonColumn<PulseSnapshot>(row.pulse_at_entry, {
      ts: row.opened_at,
    }),
    pulse_at_close: row.pulse_at_close
      ? parseJsonColumn<PulseSnapshot | null>(row.pulse_at_close, null)
      : null,
    exit_reason: (row.exit_reason as ArcExitReason | null) ?? null,
  };
}

function rowToPhaseReport(row: PhaseReportRow): PhaseReportRecord {
  return {
    id: row.id,
    arc_id: row.arc_id,
    workspace_id: row.workspace_id,
    phase_id: row.phase_id,
    mode: row.mode as Mode,
    goal: row.goal,
    status: row.status as PhaseReportStatus,
    trios_run: row.trios_run,
    runtime_sha_start: row.runtime_sha_start,
    runtime_sha_end: row.runtime_sha_end,
    cloud_sha_start: row.cloud_sha_start,
    cloud_sha_end: row.cloud_sha_end,
    delta_pulse_json: row.delta_pulse_json
      ? parseJsonColumn<Record<string, unknown> | null>(
          row.delta_pulse_json,
          null,
        )
      : null,
    delta_ledger: row.delta_ledger,
    inbox_added: row.inbox_added,
    remaining_scope: row.remaining_scope,
    next_phase_recommendation: row.next_phase_recommendation,
    cost_trios: row.cost_trios,
    cost_minutes: row.cost_minutes,
    cost_llm_cents: row.cost_llm_cents,
    raw_report: row.raw_report,
    started_at: row.started_at,
    ended_at: row.ended_at,
  };
}

function rowToFounderInbox(row: FounderInboxRow): FounderInboxRecord {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    arc_id: row.arc_id,
    phase_id: row.phase_id,
    mode: row.mode,
    blocker: row.blocker,
    context: row.context,
    options: parseJsonColumn<FounderInboxOption[]>(row.options_json, []),
    recommended: row.recommended,
    screenshot_path: row.screenshot_path,
    asked_at: row.asked_at,
    answered_at: row.answered_at,
    answer: row.answer,
    status: row.status as FounderInboxStatus,
  };
}

// ----------------------------------------------------------------------------
// director_arcs
// ----------------------------------------------------------------------------

export interface OpenArcInput {
  id: string;
  workspace_id: string;
  mode_of_invocation: ArcRecord['mode_of_invocation'];
  thesis: string;
  budget_max_phases: number;
  budget_max_minutes: number;
  budget_max_inbox_qs: number;
  kill_on_pulse_regression: boolean;
  pulse_at_entry: PulseSnapshot;
  opened_at: string;
}

export async function openArc(
  db: DatabaseAdapter,
  input: OpenArcInput,
): Promise<void> {
  const { error } = await db.from<ArcRow>('director_arcs').insert({
    id: input.id,
    workspace_id: input.workspace_id,
    opened_at: input.opened_at,
    mode_of_invocation: input.mode_of_invocation,
    thesis: input.thesis,
    status: 'open',
    budget_max_phases: input.budget_max_phases,
    budget_max_minutes: input.budget_max_minutes,
    budget_max_inbox_qs: input.budget_max_inbox_qs,
    kill_on_pulse_regression: input.kill_on_pulse_regression ? 1 : 0,
    pulse_at_entry: JSON.stringify(input.pulse_at_entry),
  });
  if (error) {
    throw new Error(`openArc failed: ${error.message}`);
  }
}

export interface CloseArcInput {
  id: string;
  status: 'closed' | 'aborted';
  exit_reason: ArcExitReason;
  pulse_at_close: PulseSnapshot;
  closed_at: string;
}

export async function closeArc(
  db: DatabaseAdapter,
  input: CloseArcInput,
): Promise<void> {
  const { error } = await db
    .from<ArcRow>('director_arcs')
    .update({
      status: input.status,
      exit_reason: input.exit_reason,
      pulse_at_close: JSON.stringify(input.pulse_at_close),
      closed_at: input.closed_at,
    })
    .eq('id', input.id);
  if (error) {
    throw new Error(`closeArc failed: ${error.message}`);
  }
}

export async function loadArc(
  db: DatabaseAdapter,
  id: string,
): Promise<ArcRecord | null> {
  const { data, error } = await db
    .from<ArcRow>('director_arcs')
    .select()
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throw new Error(`loadArc failed: ${error.message}`);
  }
  if (!data) return null;
  return rowToArc(data);
}

export async function listOpenArcs(
  db: DatabaseAdapter,
  workspace_id: string,
): Promise<ArcRecord[]> {
  const { data, error } = await db
    .from<ArcRow>('director_arcs')
    .select()
    .eq('workspace_id', workspace_id)
    .eq('status', 'open')
    .order('opened_at', { ascending: false });
  if (error) {
    throw new Error(`listOpenArcs failed: ${error.message}`);
  }
  return (data ?? []).map(rowToArc);
}

// ----------------------------------------------------------------------------
// director_phase_reports
// ----------------------------------------------------------------------------

export interface WritePhaseReportInput {
  id: string;
  arc_id: string;
  workspace_id: string;
  phase_id: string;
  mode: Mode;
  goal: string;
  status: 'queued' | 'in-flight';
  started_at: string;
}

export async function writePhaseReport(
  db: DatabaseAdapter,
  input: WritePhaseReportInput,
): Promise<void> {
  const { error } = await db
    .from<PhaseReportRow>('director_phase_reports')
    .insert({
      id: input.id,
      arc_id: input.arc_id,
      workspace_id: input.workspace_id,
      phase_id: input.phase_id,
      mode: input.mode,
      goal: input.goal,
      status: input.status,
      trios_run: 0,
      started_at: input.started_at,
    });
  if (error) {
    throw new Error(`writePhaseReport failed: ${error.message}`);
  }
}

export interface UpdatePhaseReportInput {
  id: string;
  status: PhaseReportStatus;
  trios_run: number;
  runtime_sha_start: string | null;
  runtime_sha_end: string | null;
  cloud_sha_start: string | null;
  cloud_sha_end: string | null;
  delta_pulse_json: Record<string, unknown> | null;
  delta_ledger: string | null;
  inbox_added: string | null;
  remaining_scope: string | null;
  next_phase_recommendation: string | null;
  cost_trios: number | null;
  cost_minutes: number | null;
  cost_llm_cents: number | null;
  raw_report: string | null;
  ended_at: string;
}

export async function updatePhaseReport(
  db: DatabaseAdapter,
  input: UpdatePhaseReportInput,
): Promise<void> {
  const { error } = await db
    .from<PhaseReportRow>('director_phase_reports')
    .update({
      status: input.status,
      trios_run: input.trios_run,
      runtime_sha_start: input.runtime_sha_start,
      runtime_sha_end: input.runtime_sha_end,
      cloud_sha_start: input.cloud_sha_start,
      cloud_sha_end: input.cloud_sha_end,
      delta_pulse_json: input.delta_pulse_json
        ? JSON.stringify(input.delta_pulse_json)
        : null,
      delta_ledger: input.delta_ledger,
      inbox_added: input.inbox_added,
      remaining_scope: input.remaining_scope,
      next_phase_recommendation: input.next_phase_recommendation,
      cost_trios: input.cost_trios,
      cost_minutes: input.cost_minutes,
      cost_llm_cents: input.cost_llm_cents,
      raw_report: input.raw_report,
      ended_at: input.ended_at,
    })
    .eq('id', input.id);
  if (error) {
    throw new Error(`updatePhaseReport failed: ${error.message}`);
  }
}

export async function listPhaseReportsForArc(
  db: DatabaseAdapter,
  arc_id: string,
): Promise<PhaseReportRecord[]> {
  const { data, error } = await db
    .from<PhaseReportRow>('director_phase_reports')
    .select()
    .eq('arc_id', arc_id)
    .order('started_at', { ascending: true });
  if (error) {
    throw new Error(`listPhaseReportsForArc failed: ${error.message}`);
  }
  return (data ?? []).map(rowToPhaseReport);
}

// ----------------------------------------------------------------------------
// founder_inbox
// ----------------------------------------------------------------------------

export interface WriteFounderQuestionInput {
  id: string;
  workspace_id: string;
  arc_id: string | null;
  phase_id: string | null;
  mode: string;
  blocker: string;
  context: string;
  options: FounderInboxOption[];
  recommended: string | null;
  screenshot_path: string | null;
  asked_at: string;
}

export async function writeFounderQuestion(
  db: DatabaseAdapter,
  input: WriteFounderQuestionInput,
): Promise<void> {
  const { error } = await db.from<FounderInboxRow>('founder_inbox').insert({
    id: input.id,
    workspace_id: input.workspace_id,
    arc_id: input.arc_id,
    phase_id: input.phase_id,
    mode: input.mode,
    blocker: input.blocker,
    context: input.context,
    options_json: JSON.stringify(input.options),
    recommended: input.recommended,
    screenshot_path: input.screenshot_path,
    asked_at: input.asked_at,
    status: 'open',
  });
  if (error) {
    throw new Error(`writeFounderQuestion failed: ${error.message}`);
  }
}

export async function listOpenFounderInbox(
  db: DatabaseAdapter,
  workspace_id: string,
): Promise<FounderInboxRecord[]> {
  return listFounderInboxByStatus(db, workspace_id, 'open');
}

export async function listFounderInboxByStatus(
  db: DatabaseAdapter,
  workspace_id: string,
  status: FounderInboxStatus,
): Promise<FounderInboxRecord[]> {
  const { data, error } = await db
    .from<FounderInboxRow>('founder_inbox')
    .select()
    .eq('workspace_id', workspace_id)
    .eq('status', status)
    .order('asked_at', { ascending: false });
  if (error) {
    throw new Error(`listFounderInboxByStatus failed: ${error.message}`);
  }
  return (data ?? []).map(rowToFounderInbox);
}

export async function listAnsweredFounderInbox(
  db: DatabaseAdapter,
  arc_id: string,
): Promise<FounderInboxRecord[]> {
  const { data, error } = await db
    .from<FounderInboxRow>('founder_inbox')
    .select()
    .eq('arc_id', arc_id)
    .eq('status', 'answered')
    .order('answered_at', { ascending: true });
  if (error) {
    throw new Error(`listAnsweredFounderInbox failed: ${error.message}`);
  }
  return (data ?? []).map(rowToFounderInbox);
}

/**
 * Workspace-scoped variant of `listAnsweredFounderInbox` (Bug #2,
 * Phase 6.5). Returns answered-and-unresolved inbox rows regardless of
 * which arc they originated in. The Conductor uses this BEFORE opening
 * a new arc to seed the first picker call so a founder answer that
 * lands after the originating arc closed (e.g. inbox-cap exit) still
 * gets resumed on the next tick.
 *
 * Index coverage: `idx_inbox_workspace_open(workspace_id, status,
 * asked_at DESC)` from migration 144 already covers this query — no
 * new index needed.
 */
export async function listAnsweredUnresolvedFounderInbox(
  db: DatabaseAdapter,
  workspace_id: string,
): Promise<FounderInboxRecord[]> {
  const { data, error } = await db
    .from<FounderInboxRow>('founder_inbox')
    .select()
    .eq('workspace_id', workspace_id)
    .eq('status', 'answered')
    .order('answered_at', { ascending: true });
  if (error) {
    throw new Error(
      `listAnsweredUnresolvedFounderInbox failed: ${error.message}`,
    );
  }
  return (data ?? []).map(rowToFounderInbox);
}

export async function loadFounderQuestion(
  db: DatabaseAdapter,
  id: string,
): Promise<FounderInboxRecord | null> {
  const { data, error } = await db
    .from<FounderInboxRow>('founder_inbox')
    .select()
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throw new Error(`loadFounderQuestion failed: ${error.message}`);
  }
  if (!data) return null;
  return rowToFounderInbox(data);
}

export interface AnswerFounderQuestionInput {
  id: string;
  answer: string;
  answered_at: string;
}

export async function answerFounderQuestion(
  db: DatabaseAdapter,
  input: AnswerFounderQuestionInput,
): Promise<void> {
  const { error } = await db
    .from<FounderInboxRow>('founder_inbox')
    .update({
      answer: input.answer,
      answered_at: input.answered_at,
      status: 'answered',
    })
    .eq('id', input.id);
  if (error) {
    throw new Error(`answerFounderQuestion failed: ${error.message}`);
  }
}

export async function resolveFounderQuestion(
  db: DatabaseAdapter,
  id: string,
): Promise<void> {
  const { error } = await db
    .from<FounderInboxRow>('founder_inbox')
    .update({ status: 'resolved' })
    .eq('id', id);
  if (error) {
    throw new Error(`resolveFounderQuestion failed: ${error.message}`);
  }
}

export async function countOpenFounderInbox(
  db: DatabaseAdapter,
  workspace_id: string,
): Promise<number> {
  const rows = await listOpenFounderInbox(db, workspace_id);
  return rows.length;
}

export async function countInboxAddedForPhase(
  db: DatabaseAdapter,
  phase_report_id: string,
): Promise<number> {
  const { data, error } = await db
    .from<FounderInboxRow>('founder_inbox')
    .select()
    .eq('phase_id', phase_report_id);
  if (error) {
    throw new Error(`countInboxAddedForPhase failed: ${error.message}`);
  }
  return (data ?? []).length;
}
