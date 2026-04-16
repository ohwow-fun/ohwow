/**
 * dm-reply-queue — bridge from next_step events to the X DM send path.
 *
 * Shape of the loop this module connects:
 *
 *   ContactConversationAnalyst
 *       writes next_step events (status='open')
 *           │
 *           ▼
 *   NextStepDispatcher
 *       routes question / follow_up via `proposeReplyFromNextStep()`
 *       which: (a) appends an x_dm_outbound approval to the JSONL
 *               queue (the producer-side trust gate),
 *              (b) links the approval id back into the next_step
 *               payload (`approval_id`, `dispatched_kind='reply_task'`).
 *           │  ▲
 *           │  │   operator approves via TUI / Approvals UI
 *           ▼  │
 *   XDmReplyDispatcher
 *       consumes approved rows, sends via CDP, marks 'applied'.
 *           │
 *           ▼
 *   `reconcileShippedNextSteps()`
 *       runs on the next NextStepDispatcher tick. It finds `applied`
 *       approvals whose payload names a next_step event id and stamps
 *       that event's `payload.status = 'shipped'`, closing the loop.
 *
 * The module is pure orchestration — every side effect is delegated to
 * existing primitives (approval-queue, DatabaseAdapter). Keeping it in
 * `src/lib/` means any future reply producer (email, whatsapp, manual
 * agent) can reuse `proposeReplyFromNextStep` without reaching into
 * the dispatcher class.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import {
  proposeApproval,
  readApprovalRows,
  type ApprovalEntry,
} from '../scheduling/approval-queue.js';
import { logger } from './logger.js';

/** The approval kind that XDmReplyDispatcher consumes. */
export const DM_OUTBOUND_APPROVAL_KIND = 'x_dm_outbound';

export interface ProposeReplyInput {
  approvalsJsonlPath: string;
  workspace: string;
  contactId: string;
  contactName: string | null;
  conversationPair: string;
  /** The draft reply text. Falls back to suggestedAction when empty. */
  replyText: string;
  /** Short summary shown in the Approvals UI. */
  summary: string;
  /** Event id of the next_step this reply resolves. */
  nextStepEventId: string;
  /** 'question', 'follow_up', etc. Stored in payload for audit. */
  stepType: string;
  urgency: 'high' | 'medium' | 'low';
}

/**
 * Append an x_dm_outbound approval that the existing XDmReplyDispatcher
 * will consume once approved. Trust gate is strict (autoApproveAfter=10,
 * maxPriorRejected=0) — DMs are higher-stakes than tweets. Returns the
 * new approval entry so the caller can persist its id on the originating
 * next_step event.
 */
export function proposeReplyFromNextStep(input: ProposeReplyInput): ApprovalEntry {
  const text = input.replyText.trim();
  if (!text) {
    throw new Error('proposeReplyFromNextStep: replyText is empty');
  }
  return proposeApproval(input.approvalsJsonlPath, {
    kind: DM_OUTBOUND_APPROVAL_KIND,
    workspace: input.workspace,
    summary: input.summary,
    payload: {
      conversation_pair: input.conversationPair,
      text,
      contact_id: input.contactId,
      contact_name: input.contactName,
      next_step_event_id: input.nextStepEventId,
      step_type: input.stepType,
      urgency: input.urgency,
    },
    // DMs are high-stakes. Only auto-apply after 10 prior approvals in
    // the same bucket (per contact) with zero rejections — matches the
    // guidance in XDmReplyDispatcher's header. Early in a workspace's
    // life these always land as 'pending' for operator review.
    autoApproveAfter: 10,
    maxPriorRejected: 0,
    bucketBy: 'contact_id',
  });
}

/**
 * Index of every `applied` approval keyed by its original id. This lets
 * the reconciler detect "the DM actually went out" in O(1) per next_step
 * without re-reading the JSONL on each lookup.
 */
export function buildAppliedIndex(jsonlPath: string): Map<string, AppliedRecord> {
  const rows = readApprovalRows(jsonlPath);
  const index = new Map<string, AppliedRecord>();
  // The queue is append-only: a single approval id can have multiple
  // rows (pending → approved → applied). We walk in order and record
  // only the applied row — if none exists for an id, we leave it out.
  for (const row of rows) {
    if (row.status !== 'applied') continue;
    // `notes` on an applied row is a JSON string per convention.
    let notes: Record<string, unknown> = {};
    if (typeof row.notes === 'string') {
      try { notes = JSON.parse(row.notes) as Record<string, unknown>; } catch { /* keep empty */ }
    }
    index.set(row.id, {
      approvalId: row.id,
      appliedAt: row.ts,
      notes,
    });
  }
  return index;
}

export interface AppliedRecord {
  approvalId: string;
  appliedAt: string;
  notes: Record<string, unknown>;
}

export interface NextStepRow {
  id: string;
  payload: Record<string, unknown>;
}

/**
 * Look up every next_step event in `workspaceId` whose payload carries
 * a non-null `approval_id` and `status !== 'shipped'`. Used by the
 * reconciler to narrow the set of rows it may need to update.
 */
export async function loadPendingShipNextSteps(
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<NextStepRow[]> {
  try {
    const { data } = await db
      .from<{ id: string; payload: unknown }>('agent_workforce_contact_events')
      .select('id, payload')
      .eq('workspace_id', workspaceId)
      .eq('kind', 'next_step')
      .order('created_at', { ascending: false })
      .limit(200);
    const rows = (data as Array<{ id: string; payload: unknown }> | null) ?? [];
    const out: NextStepRow[] = [];
    for (const row of rows) {
      const payload = normalizePayload(row.payload);
      if (!payload) continue;
      if (typeof payload.approval_id !== 'string') continue;
      if (payload.status === 'shipped') continue;
      out.push({ id: row.id, payload });
    }
    return out;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, workspaceId },
      '[dm-reply-queue] loadPendingShipNextSteps failed',
    );
    return [];
  }
}

/**
 * Update a next_step event's payload to mark it shipped. Idempotent —
 * re-stamping a row already at 'shipped' is cheap and safe.
 */
export async function markNextStepShipped(
  db: DatabaseAdapter,
  eventId: string,
  priorPayload: Record<string, unknown>,
  applied: AppliedRecord,
): Promise<boolean> {
  const merged: Record<string, unknown> = {
    ...priorPayload,
    status: 'shipped',
    shipped_at: applied.appliedAt,
    shipped_by: 'x_dm_reply_dispatcher',
    ship_notes: applied.notes,
  };
  try {
    await db
      .from('agent_workforce_contact_events')
      .update({ payload: JSON.stringify(merged) })
      .eq('id', eventId);
    return true;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, eventId },
      '[dm-reply-queue] markNextStepShipped update failed',
    );
    return false;
  }
}

export interface ReconcileResult {
  scanned: number;
  shipped: number;
}

export interface ConfirmResult {
  scanned: number;
  confirmed: number;
  unconfirmed: number;
}

/**
 * Close the loop: for every next_step event whose approval has been
 * `applied`, flip its status to `shipped`. Called by NextStepDispatcher
 * at the top of every tick so the Pulse UI shows reply state within
 * minutes of the actual send.
 */
export async function reconcileShippedNextSteps(
  db: DatabaseAdapter,
  workspaceId: string,
  approvalsJsonlPath: string,
): Promise<ReconcileResult> {
  const pending = await loadPendingShipNextSteps(db, workspaceId);
  if (pending.length === 0) return { scanned: 0, shipped: 0 };
  const appliedIndex = buildAppliedIndex(approvalsJsonlPath);
  if (appliedIndex.size === 0) return { scanned: pending.length, shipped: 0 };

  let shipped = 0;
  for (const row of pending) {
    const approvalId = typeof row.payload.approval_id === 'string'
      ? row.payload.approval_id
      : null;
    if (!approvalId) continue;
    const applied = appliedIndex.get(approvalId);
    if (!applied) continue;
    const ok = await markNextStepShipped(db, row.id, row.payload, applied);
    if (ok) shipped++;
  }
  if (shipped > 0) {
    logger.info(
      { workspaceId, shipped, scanned: pending.length },
      '[dm-reply-queue] reconciled next_step events as shipped',
    );
  }
  return { scanned: pending.length, shipped };
}

/**
 * Close the send-side loop: for each next_step already marked 'shipped'
 * (approval applied) find a matching REAL outbound message in
 * x_dm_messages — one whose message_id isn't the synthetic
 * `outbound-<uuid>` the reply dispatcher writes on send. Match is by
 * text equality after whitespace collapse — X may trim trailing spaces
 * but otherwise round-trips DM bodies exactly.
 *
 * When a match lands, stamp the next_step's payload with:
 *   send_confirmed: true
 *   real_message_id: <X's uuid>
 *   confirmed_at: <now>
 *
 * When no match is found after `unconfirmedGraceSec` seconds past the
 * shipped_at timestamp, stamp send_confirmed: false — operator sees
 * "applied but never landed on X" as a hard failure signal.
 */
export async function reconcileConfirmedNextSteps(
  db: DatabaseAdapter,
  workspaceId: string,
  opts: { unconfirmedGraceSec?: number } = {},
): Promise<ConfirmResult> {
  const graceSec = opts.unconfirmedGraceSec ?? 2 * 60 * 60; // 2h default

  // Load shipped-but-not-yet-confirmed next_steps.
  interface Row { id: string; payload: unknown }
  let rows: Row[] = [];
  try {
    const { data } = await db
      .from<Row>('agent_workforce_contact_events')
      .select('id, payload')
      .eq('workspace_id', workspaceId)
      .eq('kind', 'next_step')
      .order('created_at', { ascending: false })
      .limit(200);
    rows = (data as Row[] | null) ?? [];
  } catch {
    return { scanned: 0, confirmed: 0, unconfirmed: 0 };
  }

  const pending: Array<{ id: string; payload: Record<string, unknown>; pair: string; text: string; shippedAt: string }> = [];
  for (const row of rows) {
    const payload = normalizePayload(row.payload);
    if (!payload) continue;
    if (payload.status !== 'shipped') continue;
    if (payload.send_confirmed === true || payload.send_confirmed === false) continue;
    const pair = typeof payload.conversation_pair === 'string' ? payload.conversation_pair : null;
    const text = typeof payload.draft_reply === 'string' && payload.draft_reply.length > 0
      ? payload.draft_reply
      : typeof payload.suggested_action === 'string' ? payload.suggested_action : null;
    const shippedAt = typeof payload.shipped_at === 'string' ? payload.shipped_at : null;
    if (!pair || !text || !shippedAt) continue;
    pending.push({ id: row.id, payload, pair, text, shippedAt });
  }
  if (pending.length === 0) return { scanned: 0, confirmed: 0, unconfirmed: 0 };

  let confirmed = 0;
  let unconfirmed = 0;
  const now = Date.now();

  for (const row of pending) {
    // Look for a real outbound row whose text matches ours and whose
    // observed_at is >= shippedAt. Real = message_id not starting with
    // 'outbound-' (the synthetic prefix the reply dispatcher writes).
    try {
      const { data } = await db
        .from<{ message_id: string; text: string | null; observed_at: string }>('x_dm_messages')
        .select('message_id, text, observed_at')
        .eq('workspace_id', workspaceId)
        .eq('conversation_pair', row.pair)
        .eq('direction', 'outbound')
        .gte('observed_at', row.shippedAt)
        .order('observed_at', { ascending: true })
        .limit(50);
      const candidates = (data as Array<{ message_id: string; text: string | null; observed_at: string }> | null) ?? [];
      const match = candidates.find(c =>
        !c.message_id.startsWith('outbound-')
        && normalizeText(c.text ?? '') === normalizeText(row.text)
      );
      if (match) {
        const merged: Record<string, unknown> = {
          ...row.payload,
          send_confirmed: true,
          real_message_id: match.message_id,
          confirmed_at: match.observed_at,
        };
        await db.from('agent_workforce_contact_events').update({ payload: JSON.stringify(merged) }).eq('id', row.id);
        confirmed++;
        continue;
      }
      // Not found yet. If we're inside the grace window, leave pending
      // for the next tick; if past it, stamp unconfirmed so the
      // operator sees the send failed silently.
      const shippedMs = new Date(row.shippedAt).getTime();
      if (Number.isFinite(shippedMs) && (now - shippedMs) / 1000 > graceSec) {
        const merged: Record<string, unknown> = {
          ...row.payload,
          send_confirmed: false,
          unconfirmed_at: new Date().toISOString(),
        };
        await db.from('agent_workforce_contact_events').update({ payload: JSON.stringify(merged) }).eq('id', row.id);
        unconfirmed++;
      }
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : err, eventId: row.id },
        '[dm-reply-queue] confirmation lookup failed',
      );
    }
  }

  if (confirmed > 0 || unconfirmed > 0) {
    logger.info(
      { workspaceId, scanned: pending.length, confirmed, unconfirmed },
      '[dm-reply-queue] reconciled send confirmations',
    );
  }
  return { scanned: pending.length, confirmed, unconfirmed };
}

/** Whitespace-collapse for text equality. X sometimes trims trailing
 * blanks and normalises runs of spaces. Keep this narrow — we want
 * equality, not semantic fuzziness. */
function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Shared payload-normaliser: the sqlite adapter auto-parses JSON TEXT
 * columns into objects on SELECT, but older callers hand us the raw
 * string. Handle both.
 */
function normalizePayload(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
