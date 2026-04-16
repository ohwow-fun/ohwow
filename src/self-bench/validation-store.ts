/**
 * Validation store — read/write helpers for experiment_validations.
 *
 * The runner uses these to enqueue a pending validation after every
 * non-null intervention, poll for due validations on each tick, and
 * close out validation rows once the experiment's validate() returns.
 *
 * The ledger substrate (self_findings) stores the finding row for
 * each validation; this table stores the scheduling metadata and the
 * link back to the original intervention. Keeping them separate means
 * the finding table doesn't need a "pending" lifecycle column and
 * the due-queue index stays narrow.
 */

import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type {
  PendingValidation,
  ValidationOutcome,
  ValidationStatus,
} from './experiment-types.js';

interface ValidationRow {
  id: string;
  intervention_finding_id: string;
  experiment_id: string;
  baseline: string | Record<string, unknown> | null;
  validate_at: string;
  status: string;
  outcome: string | null;
  outcome_finding_id: string | null;
  error_message: string | null;
  completed_at: string | null;
  created_at: string;
}

function parseJsonSafe<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'object') return raw as T;
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToValidation(row: ValidationRow): PendingValidation {
  return {
    id: row.id,
    interventionFindingId: row.intervention_finding_id,
    experimentId: row.experiment_id,
    baseline: parseJsonSafe<Record<string, unknown>>(row.baseline, {}),
    validateAt: row.validate_at,
    status: row.status as ValidationStatus,
    createdAt: row.created_at,
  };
}

/**
 * Insert a pending validation row. Returns the new validation id
 * so the runner can link back if needed. Generates the UUID here
 * so callers don't have to.
 */
export async function enqueueValidation(
  db: DatabaseAdapter,
  row: {
    interventionFindingId: string;
    experimentId: string;
    baseline: Record<string, unknown>;
    validateAt: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db.from('experiment_validations').insert({
    id,
    intervention_finding_id: row.interventionFindingId,
    experiment_id: row.experimentId,
    baseline: JSON.stringify(row.baseline ?? {}),
    validate_at: row.validateAt,
    status: 'pending',
    created_at: new Date().toISOString(),
  });
  return id;
}

/**
 * Fetch every pending validation whose validate_at is at or before
 * the given ISO timestamp. Callers use this to drain the due queue
 * on each runner tick. No limit — pending validations should never
 * pile up more than a few per tick in practice, and skipping any
 * would delay accountability checks.
 */
export async function readDueValidations(
  db: DatabaseAdapter,
  nowIso: string,
): Promise<PendingValidation[]> {
  const { data } = await db
    .from<ValidationRow>('experiment_validations')
    .select('*')
    .eq('status', 'pending')
    .lte('validate_at', nowIso)
    .order('validate_at', { ascending: true });
  const rows = (data ?? []) as ValidationRow[];
  return rows.map(rowToValidation);
}

/**
 * Mark a validation as completed with the recorded outcome + link to
 * the finding row the runner wrote.
 */
export async function markValidationCompleted(
  db: DatabaseAdapter,
  id: string,
  outcome: ValidationOutcome,
  outcomeFindingId: string,
): Promise<void> {
  await db.from('experiment_validations').update({
    status: 'completed',
    outcome,
    outcome_finding_id: outcomeFindingId,
    completed_at: new Date().toISOString(),
  }).eq('id', id);
}

/**
 * Mark a validation as skipped (experiment unregistered or lost its
 * validate method). Records a reason in error_message for debugging.
 */
export async function markValidationSkipped(
  db: DatabaseAdapter,
  id: string,
  reason: string,
): Promise<void> {
  await db.from('experiment_validations').update({
    status: 'skipped',
    error_message: reason,
    completed_at: new Date().toISOString(),
  }).eq('id', id);
}

/**
 * Mark a validation as errored when validate() itself threw. The
 * runner logs the error and moves on; the row stays queryable for
 * operator diagnosis.
 */
export async function markValidationError(
  db: DatabaseAdapter,
  id: string,
  errorMessage: string,
): Promise<void> {
  await db.from('experiment_validations').update({
    status: 'error',
    error_message: errorMessage,
    completed_at: new Date().toISOString(),
  }).eq('id', id);
}

/**
 * Hard-delete closed validation rows older than the cutoff. "Closed"
 * is anything that ran to conclusion (completed | skipped | error) —
 * these rows have already produced their finding row in self_findings,
 * which carries the live signal. The validation row itself is just
 * scheduling metadata at that point.
 *
 * Pending rows are NEVER deleted regardless of age — a stuck pending
 * row is a real bug the operator needs to see, not GC noise.
 *
 * Counts via select-head then deletes, mirroring pruneOldSuperseded.
 * Fail-soft: any DB error returns 0 so the GC never blocks probe ticks.
 */
export async function pruneClosedValidations(
  db: DatabaseAdapter,
  cutoffIso: string,
): Promise<number> {
  try {
    const { data } = await db
      .from<{ id: string }>('experiment_validations')
      .select('id')
      .in('status', ['completed', 'skipped', 'error'])
      .lt('completed_at', cutoffIso);
    const ids = (data ?? []) as Array<{ id: string }>;
    if (ids.length === 0) return 0;
    await db
      .from('experiment_validations')
      .delete()
      .in('status', ['completed', 'skipped', 'error'])
      .lt('completed_at', cutoffIso);
    return ids.length;
  } catch {
    return 0;
  }
}

/**
 * Stamp a validation row with a successful rollback. Called by the
 * runner after rollback() returned a non-null InterventionApplied.
 * The base status stays 'completed' (validate() ran to conclusion),
 * outcome stays 'failed' (that's why we rolled back), but the
 * rolled_back columns record that the runner self-healed.
 *
 * Queries can then filter "validations that failed AND were NOT
 * rolled back" to find the cases an operator needs to investigate.
 */
export async function markValidationRolledBack(
  db: DatabaseAdapter,
  id: string,
  rollbackFindingId: string,
): Promise<void> {
  await db.from('experiment_validations').update({
    rolled_back: 1,
    rollback_finding_id: rollbackFindingId,
    rolled_back_at: new Date().toISOString(),
  }).eq('id', id);
}
