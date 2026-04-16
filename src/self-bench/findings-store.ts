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
import {
  applyNoveltyOnWrite,
  writeBaseline,
  type NoveltyInfo,
} from './insight-baseline.js';

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
 * Supersession window. When a new finding has the same
 * (experiment_id, subject, summary) as an active finding inside this
 * window, the older row gets its status flipped to 'superseded' and
 * superseded_by pointed at the new id. Default 10 minutes.
 *
 * This is the dedup fix for the P0 convergence-unobservable problem:
 * before this, dashboard-copy / ledger-health / patch-loop-health
 * wrote a new "same problem, same value" row every 30s, blowing the
 * violation pool up by 1000x against what was actually changing.
 *
 * Overridable via runtime_config_overrides key
 * `findings.supersede_window_ms` so the strategist can tune it.
 */
const DEFAULT_SUPERSEDE_WINDOW_MS = 10 * 60 * 1000;

async function supersedeDuplicates(
  db: DatabaseAdapter,
  newId: string,
  row: NewFindingRow,
  windowMs: number,
): Promise<number> {
  // Empty summary still bails — without summary the dedupe key is just
  // (experiment_id), which would suppress legitimately distinct rows.
  if (!row.summary) return 0;
  const windowStart = new Date(Date.now() - windowMs).toISOString();
  try {
    // Two query shapes depending on whether this row carries a subject.
    // Subject-bearing experiments dedupe by (experiment_id, subject,
    // summary) — the original Phase-1 contract. Subject-less ones
    // (agent-coverage-gap, experiment-author's "no proposals" message,
    // burn-rate's daily summary, ...) used to skip dedup entirely
    // because `.eq('subject', null)` evaluates to FALSE in SQL. Those
    // experiments accumulated thousands of identical active rows. The
    // null-branch here treats them by (experiment_id, summary) inside
    // the same window so the GC actually has something to reap.
    let query = db
      .from<{ id: string; summary: string }>('self_findings')
      .select('id, summary')
      .eq('experiment_id', row.experimentId)
      .eq('status', 'active')
      .gte('ran_at', windowStart);
    if (row.subject != null) {
      query = query.eq('subject', row.subject);
    } else {
      query = query.is('subject', null);
    }
    const { data } = await query;
    const dupes = (data ?? []).filter((r) => r.summary === row.summary && r.id !== newId);
    if (dupes.length === 0) return 0;
    for (const d of dupes) {
      await db
        .from('self_findings')
        .update({ status: 'superseded', superseded_by: newId })
        .eq('id', d.id);
    }
    return dupes.length;
  } catch {
    // Never block an insert on a supersession failure — pool size is
    // a soft optimization, ledger integrity is the priority.
    return 0;
  }
}

async function supersedeOnPassFlip(
  db: DatabaseAdapter,
  newId: string,
  row: NewFindingRow,
): Promise<number> {
  try {
    let query = db
      .from<{ id: string }>('self_findings')
      .select('id')
      .eq('experiment_id', row.experimentId)
      .eq('status', 'active')
      .in('verdict', ['warning', 'fail']);
    if (row.subject != null) {
      query = query.eq('subject', row.subject);
    }
    const { data } = await query;
    const stale = (data ?? []).filter((r) => r.id !== newId);
    if (stale.length === 0) return 0;
    for (const s of stale) {
      await db
        .from('self_findings')
        .update({ status: 'superseded', superseded_by: newId })
        .eq('id', s.id);
    }
    return stale.length;
  } catch {
    return 0;
  }
}

/**
 * Insert a finding row. Generates the id so callers don't have to.
 * Returns the new id.
 *
 * After insert, marks prior active findings with identical
 * (experiment_id, subject, summary) inside a 10-minute window as
 * `superseded` and points their `superseded_by` at the new id. Cuts
 * the active-pool size dramatically when an experiment re-fires the
 * same verdict every tick.
 */
export async function writeFinding(
  db: DatabaseAdapter,
  row: NewFindingRow,
  opts: { supersedeWindowMs?: number } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Piece 1: novelty pass. Read the existing baseline for
  // (experiment_id, subject), score the incoming row against it, and
  // merge a `__novelty` stanza into evidence BEFORE insert so every
  // persisted finding carries its own surprise score. The baseline row
  // itself is updated after the insert.
  const { baseline, novelty, value, trackedField } = await applyNoveltyOnWrite(db, row);
  const evidenceOut: Record<string, unknown> = {
    ...(row.evidence ?? {}),
    __novelty: noveltyStanza(novelty),
  };

  await db.from('self_findings').insert({
    id,
    experiment_id: row.experimentId,
    category: row.category,
    subject: row.subject,
    hypothesis: row.hypothesis,
    verdict: row.verdict,
    summary: row.summary,
    evidence: JSON.stringify(evidenceOut),
    intervention_applied: row.interventionApplied
      ? JSON.stringify(row.interventionApplied)
      : null,
    ran_at: row.ranAt,
    duration_ms: row.durationMs,
    status: 'active',
    created_at: now,
  });

  if (row.subject) {
    await writeBaseline(
      db,
      baseline,
      row.experimentId,
      row.subject,
      row.verdict,
      now,
      trackedField,
      value,
      novelty.consecutive_fails,
    );
  }

  await supersedeDuplicates(db, id, row, opts.supersedeWindowMs ?? DEFAULT_SUPERSEDE_WINDOW_MS);

  // When a probe flips to pass, supersede older warning/fail findings
  // for the same (experiment_id, subject). Without this, stale warnings
  // survive indefinitely and poison downstream consumers like
  // patch-author's candidate ranker.
  if (row.verdict === 'pass' && row.subject != null) {
    await supersedeOnPassFlip(db, id, row);
  }

  return id;
}

function noveltyStanza(n: NoveltyInfo): Record<string, unknown> {
  const stanza: Record<string, unknown> = {
    score: n.score,
    reason: n.reason,
    consecutive_fails: n.consecutive_fails,
    repeat_count: n.repeat_count,
  };
  if (n.detail) stanza.detail = n.detail;
  if (n.z_score !== null) stanza.z_score = n.z_score;
  return stanza;
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
 * Hard-delete `self_findings` rows whose status is 'superseded' AND
 * whose `ran_at` is older than the cutoff. The supersede pointer is a
 * soft mark (the newer row carrying the same shape replaced this one),
 * and no reader follows `superseded_by` — readers query active findings
 * directly. Anything past the longest known reader window (patch-author
 * uses 7d; observation snapshots use 30min; judges read 20 rows) is
 * dead weight at fast probe cadences.
 *
 * Counts the rows first via a select head, then issues the delete, so
 * the caller gets back the number it freed (better-sqlite3 returns a
 * `changes` count on .run() but the adapter swallows it).
 *
 * Idempotent: a second call right after returns 0. Fail-soft: any DB
 * error returns 0 and lets the caller log + continue (the GC must
 * never block probe execution).
 */
export async function pruneOldSuperseded(
  db: DatabaseAdapter,
  cutoffIso: string,
): Promise<number> {
  try {
    const { data } = await db
      .from<{ id: string }>('self_findings')
      .select('id')
      .eq('status', 'superseded')
      .lt('ran_at', cutoffIso);
    const ids = (data ?? []) as Array<{ id: string }>;
    if (ids.length === 0) return 0;
    await db
      .from('self_findings')
      .delete()
      .eq('status', 'superseded')
      .lt('ran_at', cutoffIso);
    return ids.length;
  } catch {
    return 0;
  }
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
