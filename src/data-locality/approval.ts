/**
 * Fetch Approval Queue
 *
 * When device-pinned data has requires_approval=true, the device owner
 * must approve each fetch request. This module manages the approval queue
 * with timeout-based auto-deny and event-based notifications.
 */

import crypto from 'crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { TypedEventBus } from '../lib/typed-event-bus.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ApprovalRequest {
  id: string;
  manifestEntryId: string;
  dataTitle: string;
  dataType: string;
  requestingDeviceId: string;
  requestingDeviceName: string;
  expiresAt: string;
}

export type ApprovalDecision = 'approved' | 'denied' | 'always_approve';

// ============================================================================
// APPROVAL QUEUE
// ============================================================================

/** In-memory pending approvals with resolve callbacks */
const pendingCallbacks = new Map<string, {
  resolve: (decision: ApprovalDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

/**
 * Request approval for a data fetch. Emits an event for the TUI/web UI
 * and waits for a response or timeout.
 *
 * @returns The decision, or 'denied' on timeout (default 60s)
 */
export async function requestApproval(
  db: DatabaseAdapter,
  eventBus: { emit: (event: string, data: unknown) => void } | null,
  opts: {
    manifestEntryId: string;
    dataTitle: string;
    dataType: string;
    requestingDeviceId: string;
    requestingDeviceName: string;
  },
  timeoutMs = 60_000,
): Promise<ApprovalDecision> {
  // Check auto-approve rules first
  const autoDecision = await checkAutoApproveRules(db, opts.manifestEntryId, opts.requestingDeviceId);
  if (autoDecision) return autoDecision;

  const approvalId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + timeoutMs).toISOString();

  // Persist to DB (survives restart during approval window)
  await db.from('data_fetch_approvals').insert({
    id: approvalId,
    manifest_entry_id: opts.manifestEntryId,
    requesting_device_id: opts.requestingDeviceId,
    requesting_device_name: opts.requestingDeviceName,
    status: 'pending',
    expires_at: expiresAt,
  });

  // Emit notification to TUI and web UI
  const request: ApprovalRequest = {
    id: approvalId,
    manifestEntryId: opts.manifestEntryId,
    dataTitle: opts.dataTitle,
    dataType: opts.dataType,
    requestingDeviceId: opts.requestingDeviceId,
    requestingDeviceName: opts.requestingDeviceName,
    expiresAt,
  };

  eventBus?.emit('data-fetch:approval-requested', request);
  logger.info({ approvalId, title: opts.dataTitle, from: opts.requestingDeviceName }, '[approval] Fetch approval requested');

  // Wait for response or timeout
  return new Promise<ApprovalDecision>((resolve) => {
    const timeout = setTimeout(() => {
      pendingCallbacks.delete(approvalId);
      // Mark as expired in DB
      db.from('data_fetch_approvals')
        .update({ status: 'expired', responded_at: new Date().toISOString() })
        .eq('id', approvalId)
        .then(() => {}, () => {});
      logger.info({ approvalId }, '[approval] Fetch approval expired');
      resolve('denied');
    }, timeoutMs);

    pendingCallbacks.set(approvalId, { resolve, timeout });
  });
}

/**
 * Respond to an approval request. Called by the TUI or web UI.
 */
export async function respondToApproval(
  db: DatabaseAdapter,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<boolean> {
  const pending = pendingCallbacks.get(approvalId);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingCallbacks.delete(approvalId);

  // Update DB
  const status = decision === 'always_approve' ? 'approved' : decision;
  await db.from('data_fetch_approvals')
    .update({ status, responded_at: new Date().toISOString() })
    .eq('id', approvalId);

  // If "always approve", create an auto-approve rule
  if (decision === 'always_approve') {
    const { data: approval } = await db
      .from('data_fetch_approvals')
      .select('manifest_entry_id, requesting_device_id')
      .eq('id', approvalId)
      .maybeSingle();

    if (approval) {
      const typed = approval as { manifest_entry_id: string; requesting_device_id: string };

      // Remove requires_approval on the manifest entry
      await db.from('device_data_manifest')
        .update({ requires_approval: 0 })
        .eq('id', typed.manifest_entry_id);

      logger.info({ approvalId, manifestEntryId: typed.manifest_entry_id }, '[approval] Auto-approve enabled for entry');
    }
  }

  pending.resolve(decision);
  logger.info({ approvalId, decision }, '[approval] Fetch approval responded');
  return true;
}

/**
 * Get pending approval requests (for UI polling).
 */
export async function getPendingApprovals(
  db: DatabaseAdapter,
): Promise<ApprovalRequest[]> {
  const now = new Date().toISOString();

  const { data } = await db
    .from('data_fetch_approvals')
    .select('id, manifest_entry_id, requesting_device_id, requesting_device_name, expires_at')
    .eq('status', 'pending')
    .gt('expires_at', now)
    .order('created_at', { ascending: false })
    .limit(10);

  if (!data) return [];

  // Enrich with manifest titles
  const results: ApprovalRequest[] = [];
  for (const row of data as Array<Record<string, string>>) {
    const { data: manifest } = await db
      .from('device_data_manifest')
      .select('title, data_type')
      .eq('id', row.manifest_entry_id)
      .maybeSingle();

    const m = manifest as { title: string; data_type: string } | null;
    results.push({
      id: row.id,
      manifestEntryId: row.manifest_entry_id,
      dataTitle: m?.title ?? 'Unknown',
      dataType: m?.data_type ?? 'unknown',
      requestingDeviceId: row.requesting_device_id,
      requestingDeviceName: row.requesting_device_name ?? 'Unknown device',
      expiresAt: row.expires_at,
    });
  }

  return results;
}

// ============================================================================
// AUTO-APPROVE RULES
// ============================================================================

async function checkAutoApproveRules(
  db: DatabaseAdapter,
  manifestEntryId: string,
  _requestingDeviceId: string,
): Promise<ApprovalDecision | null> {
  // Check if the manifest entry has requires_approval disabled (always approve)
  const { data: entry } = await db
    .from('device_data_manifest')
    .select('requires_approval')
    .eq('id', manifestEntryId)
    .maybeSingle();

  if (entry && !(entry as { requires_approval: number | boolean }).requires_approval) {
    return 'approved';
  }

  return null;
}

/**
 * Cancel all pending approval timers. Call on shutdown.
 */
export function cancelAllPendingApprovals(): void {
  for (const [id, pending] of pendingCallbacks) {
    clearTimeout(pending.timeout);
    pending.resolve('denied');
  }
  pendingCallbacks.clear();
}
