/**
 * approved-draft-queue — read operator-approved X drafts from the
 * workspace's `x-approvals.jsonl` ledger so the content-cadence
 * dispatcher can post pre-approved text directly, bypassing the
 * LLM-author iteration that has historically produced a steady
 * stream of capitulations ("## Tweet Ready for Manual Posting").
 *
 * Why JSONL not a DB table
 * -----------------------
 * x-approvals.jsonl is the existing operator-surface source of truth —
 * `scripts/x-experiments/_approvals.mjs` already appends proposals,
 * rates them, and auto-escalates to `auto_applied` when the trust
 * floor is met. Re-home-ing that into SQL would force a migration
 * and duplicate state. Instead: read the file in place, select one
 * draft, write a consumption event when the dispatcher actually
 * posts. The operator's existing rating flow stays authoritative.
 *
 * Consumption semantics
 * ---------------------
 * A draft is "consumable" when:
 *   1. payload.post_text is a non-empty string
 *   2. status ∈ {'approved', 'auto_applied'}  (pending / rejected /
 *      already-applied are skipped)
 *   3. no prior line in the same file marks it as posted — we look
 *      for `notes` containing `"posted":true` or `status='applied'`
 *      events that reference the same id
 *
 * Oldest-first ordering: simplest fair policy, prevents starvation
 * of stale-but-approved drafts while an operator keeps adding new
 * ones. The dispatcher only picks one per tick; deeper ranking
 * (shape diversity, engagement proxy) can layer on later by filtering
 * the candidate list before we pick [0].
 */

import fs from 'node:fs';
import { logger } from '../lib/logger.js';
import { hashPostText } from '../lib/posted-text-log.js';

/** Shape observed in x-approvals.jsonl as written by scripts/x-experiments/_approvals.mjs. */
interface ApprovalRow {
  id?: string;
  ts?: string;
  kind?: string;
  workspace?: string;
  status?: string;
  notes?: string;
  ratedAt?: string;
  payload?: {
    post_text?: string;
    draft?: string;
    shape?: string;
    seed_bucket?: string;
    bucket?: string;
    confidence?: number;
    permalink?: string;
  };
}

/** What the dispatcher needs to stamp a task + deliverable. */
export interface ApprovedDraft {
  id: string;
  text: string;
  ts: string;
  kind: string;
  shape: string | null;
  bucket: string | null;
  source_permalink: string | null;
}

/** Status values that mark a draft as consumed (no re-post). */
const CONSUMED_STATUSES = new Set(['applied', 'rejected']);
/** Status values that make a draft eligible to post. */
const APPROVED_STATUSES = new Set(['approved', 'auto_applied']);

function readJsonl(absPath: string): ApprovalRow[] {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }
  const rows: ApprovalRow[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as ApprovalRow);
    } catch {
      // Swallow one bad line; JSONL shouldn't die on a partial write.
    }
  }
  return rows;
}

/**
 * Read the ledger and return every row whose id appears in a
 * consumption event (status ∈ {applied,rejected} OR notes mentions
 * "posted":true). The ledger is append-only so the LAST row for a
 * given id wins.
 *
 * We export this shape so callers (tests, diagnostics) can introspect
 * without re-implementing the roll-up logic.
 */
export function collectConsumedIds(rows: ApprovalRow[]): Set<string> {
  const consumed = new Set<string>();
  for (const row of rows) {
    if (!row.id) continue;
    if (row.status && CONSUMED_STATUSES.has(row.status)) {
      consumed.add(row.id);
      continue;
    }
    if (typeof row.notes === 'string' && row.notes.includes('"posted":true')) {
      consumed.add(row.id);
    }
  }
  return consumed;
}

/**
 * Pick the oldest approved-but-not-yet-posted draft from the ledger.
 * Returns null when nothing qualifies — dispatcher falls back to the
 * agent-authoring path.
 *
 * kind filter (default `x_outbound_post`) keeps us from posting a
 * reply draft as a standalone post. Pass explicit kinds=['*'] to opt
 * out of filtering; pass ['x_outbound_post','x_outbound_reply'] if
 * the dispatcher grows reply support later.
 */
export function selectApprovedDraft(
  jsonlPath: string,
  opts: { kinds?: readonly string[]; deniedTextHashes?: ReadonlySet<string> } = {},
): ApprovedDraft | null {
  const rows = readJsonl(jsonlPath);
  if (rows.length === 0) return null;
  const consumed = collectConsumedIds(rows);
  const kinds = opts.kinds ?? ['x_outbound_post'];
  const allowAllKinds = kinds.length === 1 && kinds[0] === '*';
  const denied = opts.deniedTextHashes;

  // Dedup by id — the ledger appends rating events as new rows with
  // the same id; we want each id considered once using the final
  // status visible in the file.
  const latestById = new Map<string, ApprovalRow>();
  for (const row of rows) {
    if (row.id) latestById.set(row.id, row);
  }

  const candidates: ApprovalRow[] = [];
  for (const row of latestById.values()) {
    if (!row.id || consumed.has(row.id)) continue;
    if (!row.status || !APPROVED_STATUSES.has(row.status)) continue;
    const text = row.payload?.post_text?.trim() ?? row.payload?.draft?.trim() ?? '';
    if (!text) continue;
    if (!allowAllKinds) {
      const k = row.kind ?? '';
      if (!kinds.includes(k)) continue;
    }
    // Pre-pick dedup against the persistent posted-text log. Avoids
    // dispatching approvals whose text already landed on X in the
    // lookback window — saves a CDP lane slot and a round-trip
    // through the duplicate-content banner. The caller preloads the
    // deny set from x_posted_log because this function is sync.
    if (denied && denied.has(hashPostText(text))) {
      logger.info(
        { draftId: row.id },
        '[approved-draft-queue] skipping draft; text already in posted log',
      );
      continue;
    }
    candidates.push(row);
  }

  if (candidates.length === 0) return null;

  // Oldest first. Missing ts sorts last so malformed rows never beat
  // a well-dated one.
  candidates.sort((a, b) => {
    const ta = a.ts ?? '\uffff';
    const tb = b.ts ?? '\uffff';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  const picked = candidates[0];
  const text = picked.payload?.post_text?.trim() ?? picked.payload?.draft?.trim() ?? '';
  return {
    id: picked.id!,
    text,
    ts: picked.ts ?? '',
    kind: picked.kind ?? '',
    shape: typeof picked.payload?.shape === 'string' ? picked.payload.shape : null,
    bucket: (picked.payload?.bucket ?? picked.payload?.seed_bucket) ?? null,
    source_permalink: typeof picked.payload?.permalink === 'string' ? picked.payload.permalink : null,
  };
}

/**
 * Append a consumption event so the NEXT call to selectApprovedDraft
 * sees this id as consumed and skips it. Same-file idempotency — we
 * append, never rewrite, so concurrent writers can't corrupt state.
 *
 * Emits a row with status='applied' + notes carrying the task link,
 * matching the existing ledger convention used by
 * scripts/x-experiments/_approvals.mjs::rate. Downstream tooling
 * that greps for `"posted":true` keeps working.
 */
export function markDraftConsumed(
  jsonlPath: string,
  draftId: string,
  taskId: string,
): void {
  const event: ApprovalRow = {
    id: draftId,
    ts: new Date().toISOString(),
    status: 'applied',
    notes: JSON.stringify({ posted: true, by: 'content_cadence_dispatcher', task_id: taskId }),
  };
  try {
    fs.appendFileSync(jsonlPath, JSON.stringify(event) + '\n', 'utf-8');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, jsonlPath, draftId },
      '[approved-draft-queue] failed to append consumption event; draft may be double-posted on next tick',
    );
  }
}
