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
