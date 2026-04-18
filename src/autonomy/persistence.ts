/**
 * Trio + Round persistence for the Phase orchestrator.
 *
 * Phase 3 deliberately keeps this module thin: just typed wrappers over
 * the DatabaseAdapter that write to / read from `phase_trios` and
 * `phase_rounds` (migration 143). Director-tier writes
 * (`director_phase_reports`, `director_arcs`, `founder_inbox`) are
 * Phase 4 territory.
 *
 * JSON columns (`findings_written`, `commits`, `evaluation_json`,
 * `raw_return`) are serialised on write and deserialised on read so
 * callers always work with native TS shapes.
 */

import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type {
  Mode,
  RoundBrief,
  RoundEvaluation,
  RoundKind,
  RoundReturn,
  RoundStatus,
  TrioOutcome,
} from './types.js';

// ----------------------------------------------------------------------------
// Row shapes — what's actually in SQLite
// ----------------------------------------------------------------------------

interface TrioRow {
  id: string;
  phase_id: string;
  workspace_id: string;
  mode: Mode;
  outcome: TrioOutcome;
  started_at: string;
  ended_at: string | null;
}

interface RoundRow {
  id: string;
  trio_id: string;
  kind: RoundKind;
  status: RoundStatus;
  summary: string;
  /** JSON string (string[]) */
  findings_written: string | null;
  /** JSON string (string[]) */
  commits: string | null;
  /** JSON string (RoundEvaluation) */
  evaluation_json: string | null;
  /** JSON string (full RoundReturn) */
  raw_return: string | null;
  started_at: string;
  ended_at: string | null;
}

// ----------------------------------------------------------------------------
// Public types — what callers consume
// ----------------------------------------------------------------------------

export interface TrioRecord {
  id: string;
  phase_id: string;
  workspace_id: string;
  mode: Mode;
  outcome: TrioOutcome;
  started_at: string;
  ended_at: string | null;
}

export interface RoundRecord {
  id: string;
  trio_id: string;
  kind: RoundKind;
  status: RoundStatus;
  summary: string;
  findings_written: string[];
  commits: string[];
  evaluation: RoundEvaluation | null;
  /** Original RoundReturn parsed back from JSON. */
  raw_return: RoundReturn | null;
  started_at: string;
  ended_at: string | null;
}

// ----------------------------------------------------------------------------
// Writes
// ----------------------------------------------------------------------------

export interface WriteTrioInput {
  id: string;
  phase_id: string;
  workspace_id: string;
  mode: Mode;
  outcome: TrioOutcome;
  started_at: string;
}

export async function writeTrio(
  db: DatabaseAdapter,
  input: WriteTrioInput,
): Promise<void> {
  const { error } = await db.from<TrioRow>('phase_trios').insert({
    id: input.id,
    phase_id: input.phase_id,
    workspace_id: input.workspace_id,
    mode: input.mode,
    outcome: input.outcome,
    started_at: input.started_at,
  });
  if (error) {
    throw new Error(`writeTrio failed: ${error.message}`);
  }
}

export interface UpdateTrioOutcomeInput {
  id: string;
  outcome: TrioOutcome;
  ended_at: string;
}

export async function updateTrioOutcome(
  db: DatabaseAdapter,
  input: UpdateTrioOutcomeInput,
): Promise<void> {
  const { error } = await db
    .from<TrioRow>('phase_trios')
    .update({ outcome: input.outcome, ended_at: input.ended_at })
    .eq('id', input.id);
  if (error) {
    throw new Error(`updateTrioOutcome failed: ${error.message}`);
  }
}

export interface WriteRoundInput {
  id: string;
  trio_id: string;
  kind: RoundKind;
  brief: RoundBrief;
  ret: RoundReturn;
  started_at: string;
  ended_at: string;
}

export async function writeRound(
  db: DatabaseAdapter,
  input: WriteRoundInput,
): Promise<void> {
  const { error } = await db.from<RoundRow>('phase_rounds').insert({
    id: input.id,
    trio_id: input.trio_id,
    kind: input.kind,
    status: input.ret.status,
    summary: input.ret.summary,
    findings_written: JSON.stringify(input.ret.findings_written),
    commits: JSON.stringify(input.ret.commits),
    evaluation_json: input.ret.evaluation
      ? JSON.stringify(input.ret.evaluation)
      : null,
    raw_return: JSON.stringify(input.ret),
    started_at: input.started_at,
    ended_at: input.ended_at,
  });
  if (error) {
    throw new Error(`writeRound failed: ${error.message}`);
  }
}

// ----------------------------------------------------------------------------
// Reads
// ----------------------------------------------------------------------------

/**
 * The sqlite adapter eagerly parses TEXT columns whose values look like
 * JSON objects/arrays back into native shapes. So a row coming back can
 * already have `findings_written` as `string[]`. We accept both forms.
 */
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

function rowToRoundRecord(row: RoundRow): RoundRecord {
  const findings = parseJsonColumn<string[]>(row.findings_written, []);
  const commits = parseJsonColumn<string[]>(row.commits, []);
  const evaluation = parseJsonColumn<RoundEvaluation | null>(
    row.evaluation_json,
    null,
  );
  const raw = parseJsonColumn<RoundReturn | null>(row.raw_return, null);
  return {
    id: row.id,
    trio_id: row.trio_id,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    findings_written: findings,
    commits,
    evaluation,
    raw_return: raw,
    started_at: row.started_at,
    ended_at: row.ended_at,
  };
}

function rowToTrioRecord(row: TrioRow): TrioRecord {
  return {
    id: row.id,
    phase_id: row.phase_id,
    workspace_id: row.workspace_id,
    mode: row.mode,
    outcome: row.outcome,
    started_at: row.started_at,
    ended_at: row.ended_at,
  };
}

export async function loadTrio(
  db: DatabaseAdapter,
  trioId: string,
): Promise<{ trio: TrioRecord; rounds: RoundRecord[] } | null> {
  const trioRes = await db
    .from<TrioRow>('phase_trios')
    .select()
    .eq('id', trioId)
    .maybeSingle();
  if (trioRes.error) {
    throw new Error(`loadTrio failed (trio): ${trioRes.error.message}`);
  }
  if (!trioRes.data) return null;
  const rounds = await listRoundsForTrio(db, trioId);
  return { trio: rowToTrioRecord(trioRes.data), rounds };
}

export async function listRoundsForTrio(
  db: DatabaseAdapter,
  trioId: string,
): Promise<RoundRecord[]> {
  const { data, error } = await db
    .from<RoundRow>('phase_rounds')
    .select()
    .eq('trio_id', trioId)
    .order('started_at', { ascending: true });
  if (error) {
    throw new Error(`listRoundsForTrio failed: ${error.message}`);
  }
  if (!data) return [];
  return data.map(rowToRoundRecord);
}

// ----------------------------------------------------------------------------
// Logging helper — exported so the orchestrator can keep its own log calls
// scoped without re-importing logger here.
// ----------------------------------------------------------------------------

export function logPersistError(
  ctx: Record<string, unknown>,
  err: unknown,
): void {
  logger.error({ ...ctx, err: (err as Error).message }, 'autonomy.persist.error');
}
