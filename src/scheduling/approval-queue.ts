/**
 * approval-queue — daemon-side TS port of the propose/rate/apply
 * primitives originally in `scripts/x-experiments/_approvals.mjs`.
 *
 * Why it's a port and not a wrapper
 * ---------------------------------
 * The daemon does not load `.mjs` scripts. Historically that meant
 * daemon code could READ `x-approvals.jsonl` (via approved-draft-queue.ts)
 * but could not propose new entries. As we start wiring autonomous
 * producers (e.g. auto-drafted DM replies triggered by inbound signals)
 * the daemon needs to write proposals too. Porting keeps the JSONL
 * file as the single source of truth shared with the CLI; the CLI's
 * `rate()` rewrites are still authoritative because this module uses
 * the same schema.
 *
 * Shared file: `~/.ohwow/workspaces/<ws>/x-approvals.jsonl`. The CLI's
 * `writeQueue` rewrites the file on each rate; we APPEND propose and
 * applied events so a concurrent CLI rewrite can only lose a proposal
 * that raced with it (window ~ms, impact one line — operator can
 * re-propose). The reader side already deduplicates by id, taking the
 * latest status visible in the file.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../lib/logger.js';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'auto_applied';

export interface ApprovalEntry {
  id: string;
  ts: string;
  kind: string;
  workspace: string;
  summary: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  notes?: string;
  ratedAt?: string;
  trustStats?: {
    priorApproved: number;
    priorRejected: number;
    bucketBy: string | null;
    bucketValue: unknown;
  };
}

export interface ProposeApprovalInput {
  kind: string;
  workspace: string;
  summary: string;
  payload: Record<string, unknown>;
  /** Prior-approved count required before auto-applying. Default 10. */
  autoApproveAfter?: number;
  /**
   * Max prior-rejected entries tolerated in the same bucket. When null
   * (default), uses the legacy ratio rule `1 + floor(approved / 10)`.
   * Set to 0 for high-stakes kinds where one rejection must block
   * further auto-apply until the operator explicitly approves again.
   */
  maxPriorRejected?: number | null;
  /**
   * Payload key that scopes trust counts. When set, priorApproved and
   * priorRejected only consider entries with the same value for this
   * payload key. Used by x_outbound_post where rejection signal is
   * meaningful per shape.
   */
  bucketBy?: string | null;
  /** Optional secondary check; fail-closed on throw. */
  gate?: (kind: string, payload: Record<string, unknown>) => boolean;
}

const APPROVED_STATUSES: ReadonlySet<ApprovalStatus> = new Set<ApprovalStatus>([
  'approved',
  'auto_applied',
]);
const COUNTS_AS_APPROVED: ReadonlySet<ApprovalStatus> = new Set<ApprovalStatus>([
  'approved',
  'applied',
  'auto_applied',
]);
const COUNTS_AS_REJECTED: ReadonlySet<ApprovalStatus> = new Set<ApprovalStatus>([
  'rejected',
]);

/**
 * Read every JSONL row from the approvals file. Malformed lines are
 * silently skipped — the file is append-only for proposals/consumption
 * events and a partial write should never crash the caller.
 */
export function readApprovalRows(jsonlPath: string): ApprovalEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf-8');
  } catch {
    return [];
  }
  const rows: ApprovalEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as ApprovalEntry);
    } catch {
      // swallow partial/corrupt lines
    }
  }
  return rows;
}

/**
 * Latest status per id — the JSONL is append-only so the LAST row for
 * an id carries the authoritative state. Mirrors approved-draft-queue's
 * dedup behavior so both readers agree on what's consumable.
 */
function latestById(rows: ApprovalEntry[]): Map<string, ApprovalEntry> {
  const latest = new Map<string, ApprovalEntry>();
  for (const row of rows) {
    if (row.id) latest.set(row.id, row);
  }
  return latest;
}

function appendEntry(jsonlPath: string, entry: ApprovalEntry | { id: string; ts: string; status: ApprovalStatus; notes?: string }): void {
  fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
  fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Append a new proposal. Matches the CLI's auto-approval logic: an
 * entry is written with `status='auto_applied'` when the bucket has
 * enough prior approvals AND no rejections over the ceiling AND the
 * optional gate passes. Otherwise the entry lands as 'pending' and
 * waits for the operator to rate it via the CLI.
 *
 * Returns the full entry so the caller can thread its id into follow-
 * up writes (e.g. a DB row linking the proposal to its originating
 * signal).
 */
export function proposeApproval(
  jsonlPath: string,
  input: ProposeApprovalInput,
): ApprovalEntry {
  const rows = readApprovalRows(jsonlPath);
  const latest = latestById(rows);

  const bucketBy = input.bucketBy ?? null;
  const bucketValue = bucketBy && Object.prototype.hasOwnProperty.call(input.payload, bucketBy)
    ? input.payload[bucketBy]
    : null;
  const inBucket = (e: ApprovalEntry): boolean => {
    if (e.kind !== input.kind) return false;
    if (!bucketBy) return true;
    if (bucketValue === null || bucketValue === undefined) return false;
    return e.payload && e.payload[bucketBy] === bucketValue;
  };

  let priorApproved = 0;
  let priorRejected = 0;
  for (const entry of latest.values()) {
    if (!inBucket(entry)) continue;
    if (COUNTS_AS_APPROVED.has(entry.status)) priorApproved++;
    else if (COUNTS_AS_REJECTED.has(entry.status)) priorRejected++;
  }

  const autoApproveAfter = input.autoApproveAfter ?? 10;
  const rejectedCeiling = input.maxPriorRejected === undefined || input.maxPriorRejected === null
    ? Math.max(1, Math.floor(priorApproved / 10))
    : input.maxPriorRejected;
  const trusted = priorApproved >= autoApproveAfter && priorRejected <= rejectedCeiling;

  let gatePassed = true;
  if (trusted && typeof input.gate === 'function') {
    try {
      gatePassed = input.gate(input.kind, input.payload) === true;
    } catch {
      gatePassed = false;
    }
  }

  const entry: ApprovalEntry = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    kind: input.kind,
    workspace: input.workspace,
    summary: input.summary,
    payload: input.payload,
    status: trusted && gatePassed ? 'auto_applied' : 'pending',
    trustStats: { priorApproved, priorRejected, bucketBy, bucketValue },
  };
  appendEntry(jsonlPath, entry);
  return entry;
}

/**
 * Return entries of `kind` that are approved (operator-approved OR
 * auto-applied by the trust gate) AND have not yet been applied.
 *
 * "Applied" is tracked by a subsequent row with `status='applied'`
 * carrying the same id. The CLI's `rate()` also uses 'applied' when
 * marking a manual execution done, so the semantics are shared.
 *
 * Rejected and pending entries are filtered out.
 *
 * Oldest-first so long-pending approvals drain before fresh ones.
 */
export function listApprovalsForKind(
  jsonlPath: string,
  kind: string,
): ApprovalEntry[] {
  const rows = readApprovalRows(jsonlPath);
  if (rows.length === 0) return [];
  const latest = latestById(rows);
  const out: ApprovalEntry[] = [];
  for (const entry of latest.values()) {
    if (entry.kind !== kind) continue;
    if (!APPROVED_STATUSES.has(entry.status)) continue;
    out.push(entry);
  }
  out.sort((a, b) => {
    const ta = a.ts ?? '\uffff';
    const tb = b.ts ?? '\uffff';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  return out;
}

/**
 * Append an `applied` event so future reads see this approval as
 * consumed. `notes` is JSON-stringified into the notes field to match
 * the CLI's convention. The approvals queue stays append-only; no
 * in-place rewrites from the daemon side.
 */
export function markApprovalApplied(
  jsonlPath: string,
  id: string,
  notes: Record<string, unknown>,
): void {
  try {
    appendEntry(jsonlPath, {
      id,
      ts: new Date().toISOString(),
      status: 'applied',
      notes: JSON.stringify(notes),
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, jsonlPath, id },
      '[approval-queue] failed to append applied event; may be re-applied next tick',
    );
  }
}
