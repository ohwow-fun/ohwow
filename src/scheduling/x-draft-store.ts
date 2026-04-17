/**
 * x-draft-store — thin DB access layer for the x_post_drafts table.
 *
 * Seeded by XDraftDistillerScheduler, read/mutated by the MCP tools
 * (ohwow_list_x_drafts / ohwow_approve_x_draft / ohwow_reject_x_draft)
 * and the forthcoming posting handler that flips approved rows into
 * actual X posts.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

export type XDraftStatus = 'pending' | 'approved' | 'rejected';

export interface XPostDraftRow {
  id: string;
  workspace_id: string;
  body: string;
  source_finding_id: string | null;
  status: XDraftStatus;
  created_at: string;
  approved_at: string | null;
  rejected_at: string | null;
}

export interface InsertDraftInput {
  workspaceId: string;
  body: string;
  sourceFindingId: string | null;
}

/**
 * Find a draft by source_finding_id. Used by the distiller to dedup
 * before spending an LLM call on a finding it has already drafted.
 */
export async function findDraftByFindingId(
  db: DatabaseAdapter,
  workspaceId: string,
  sourceFindingId: string,
): Promise<XPostDraftRow | null> {
  try {
    const { data } = await db
      .from<XPostDraftRow>('x_post_drafts')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('source_finding_id', sourceFindingId)
      .limit(1);
    return data && data.length > 0 ? data[0] : null;
  } catch (err) {
    logger.warn({ err, workspaceId, sourceFindingId }, 'x-draft-store: findByFindingId failed');
    return null;
  }
}

/**
 * Insert a draft. Returns the new row on success, null if the UNIQUE
 * (workspace_id, source_finding_id) constraint fires (race-safe) or
 * the insert otherwise fails.
 */
export async function insertDraft(
  db: DatabaseAdapter,
  input: InsertDraftInput,
): Promise<XPostDraftRow | null> {
  const row: XPostDraftRow = {
    id: randomUUID().replace(/-/g, ''),
    workspace_id: input.workspaceId,
    body: input.body,
    source_finding_id: input.sourceFindingId,
    status: 'pending',
    created_at: new Date().toISOString(),
    approved_at: null,
    rejected_at: null,
  };
  try {
    const { error } = await db.from<XPostDraftRow>('x_post_drafts').insert(row);
    if (error) {
      logger.info({ error }, 'x-draft-store: insert rejected (likely dup)');
      return null;
    }
    return row;
  } catch (err) {
    logger.warn({ err, workspaceId: input.workspaceId }, 'x-draft-store: insert threw');
    return null;
  }
}

export interface ListDraftsFilters {
  status?: XDraftStatus;
  limit?: number;
}

export async function listDrafts(
  db: DatabaseAdapter,
  workspaceId: string,
  filters: ListDraftsFilters = {},
): Promise<XPostDraftRow[]> {
  try {
    let q = db
      .from<XPostDraftRow>('x_post_drafts')
      .select('*')
      .eq('workspace_id', workspaceId);
    if (filters.status) {
      q = q.eq('status', filters.status);
    }
    const { data } = await q.order('created_at', { ascending: false }).limit(
      Math.min(Math.max(filters.limit ?? 50, 1), 200),
    );
    return data ?? [];
  } catch (err) {
    logger.warn({ err, workspaceId }, 'x-draft-store: list failed');
    return [];
  }
}

export async function setDraftStatus(
  db: DatabaseAdapter,
  workspaceId: string,
  id: string,
  status: Exclude<XDraftStatus, 'pending'>,
): Promise<XPostDraftRow | null> {
  const now = new Date().toISOString();
  const patch: Partial<XPostDraftRow> = { status };
  if (status === 'approved') patch.approved_at = now;
  if (status === 'rejected') patch.rejected_at = now;
  try {
    await db
      .from<XPostDraftRow>('x_post_drafts')
      .update(patch)
      .eq('workspace_id', workspaceId)
      .eq('id', id);
    // Read back the freshly updated row so callers can see the new
    // timestamps. setStatus is a low-rate operator action, the extra
    // round-trip is fine.
    const { data } = await db
      .from<XPostDraftRow>('x_post_drafts')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('id', id)
      .limit(1);
    return data && data.length > 0 ? data[0] : null;
  } catch (err) {
    logger.warn({ err, workspaceId, id, status }, 'x-draft-store: setStatus failed');
    return null;
  }
}
