/**
 * Findings store — read/write helpers for the self_findings ledger.
 *
 * The ExperimentRunner writes one row per experiment per run. The
 * ExperimentContext's recentFindings() method reads them back so
 * history-aware judges can make decisions based on trends. Operators
 * query the same table via /api/findings and ohwow_list_findings.
 *
 * Errors are NOT swallowed here — the runner is the layer that
 * swallows errors so a store failure doesn't break probe execution.
 * This module returns the raw error and lets the runner log + recover.
 */

import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type {
  Finding,
  ExperimentCategory,
  NewFindingRow,
  Verdict,
  FindingStatus,
  InterventionApplied,
} from './experiment-types.js';

interface SelfFindingRow {
  id: string;
  experiment_id: string;
  category: string;
  subject: string | null;
  hypothesis: string | null;
  verdict: string;
  summary: string;
  evidence: string;
  intervention_applied: string | null;
  ran_at: string;
  duration_ms: number;
  status: string;
  superseded_by: string | null;
  created_at: string;
}

function parseJsonSafe<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  // Some DB adapters return TEXT JSON columns already parsed as
  // objects — accept both shapes so readers don't silently land {}
  // when the adapter was helpful.
  if (typeof raw === 'object') return raw as T;
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToFinding(row: SelfFindingRow): Finding {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    category: row.category as ExperimentCategory,
    subject: row.subject,
    hypothesis: row.hypothesis,
    verdict: row.verdict as Verdict,
    summary: row.summary,
    evidence: parseJsonSafe<Record<string, unknown>>(row.evidence, {}),
    interventionApplied: parseJsonSafe<InterventionApplied | null>(row.intervention_applied, null),
    ranAt: row.ran_at,
    durationMs: row.duration_ms,
    status: row.status as FindingStatus,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
  };
}

/**
 * Insert a finding row. Generates the id so callers don't have to.
 * Returns the new id.
 */
export async function writeFinding(
  db: DatabaseAdapter,
  row: NewFindingRow,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.from('self_findings').insert({
    id,
    experiment_id: row.experimentId,
    category: row.category,
    subject: row.subject,
    hypothesis: row.hypothesis,
    verdict: row.verdict,
    summary: row.summary,
    evidence: JSON.stringify(row.evidence ?? {}),
    intervention_applied: row.interventionApplied
      ? JSON.stringify(row.interventionApplied)
      : null,
    ran_at: row.ranAt,
    duration_ms: row.durationMs,
    status: 'active',
    created_at: new Date().toISOString(),
  });
  return id;
}

/**
 * Read the most recent N findings for a given experiment, newest first.
 * Used by history-aware judges and by the recentFindings() helper on
 * ExperimentContext.
 */
export async function readRecentFindings(
  db: DatabaseAdapter,
  experimentId: string,
  limit = 20,
): Promise<Finding[]> {
  const { data } = await db
    .from<SelfFindingRow>('self_findings')
    .select('*')
    .eq('experiment_id', experimentId)
    .order('ran_at', { ascending: false })
    .limit(limit);
  const rows = (data ?? []) as SelfFindingRow[];
  return rows.map(rowToFinding);
}

/** Filter knobs for list queries. All optional. */
export interface ListFindingsFilters {
  experimentId?: string;
  category?: ExperimentCategory;
  verdict?: Verdict;
  subject?: string;
  status?: FindingStatus;
  limit?: number;
}

/**
 * General-purpose finding list query. Backs the REST endpoint and MCP
 * tool. Defaults to active findings sorted newest first with a cap of
 * 50 rows so an operator hitting the endpoint without filters doesn't
 * accidentally pull every row the system has ever written.
 */
export async function listFindings(
  db: DatabaseAdapter,
  filters: ListFindingsFilters = {},
): Promise<Finding[]> {
  let query = db
    .from<SelfFindingRow>('self_findings')
    .select('*');
  if (filters.experimentId) query = query.eq('experiment_id', filters.experimentId);
  if (filters.category) query = query.eq('category', filters.category);
  if (filters.verdict) query = query.eq('verdict', filters.verdict);
  if (filters.subject) query = query.eq('subject', filters.subject);
  query = query.eq('status', filters.status ?? 'active');
  const { data } = await query
    .order('ran_at', { ascending: false })
    .limit(Math.min(filters.limit ?? 50, 500));
  const rows = (data ?? []) as SelfFindingRow[];
  return rows.map(rowToFinding);
}
