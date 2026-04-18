/**
 * x-reply-store — DB access layer for the x_reply_drafts table.
 *
 * One table serves both X and Threads reply drafts (platform column
 * distinguishes). Seeded by the reply schedulers, read/mutated by the
 * MCP tools (ohwow_list_x_reply_drafts / ohwow_approve_x_reply_draft /
 * ohwow_reject_x_reply_draft) and consumed by the reply dispatchers.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

export type ReplyDraftStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'auto_applied';
export type ReplyDraftPlatform = 'x' | 'threads';
export type ReplyDraftMode = 'direct' | 'viral';

export interface ReplyDraftRow {
  id: string;
  workspace_id: string;
  platform: ReplyDraftPlatform;
  reply_to_url: string;
  reply_to_author: string | null;
  reply_to_text: string | null;
  reply_to_likes: number | null;
  reply_to_replies: number | null;
  mode: ReplyDraftMode;
  body: string;
  alternates_json: string | null;
  verdict_json: string | null;
  score: number | null;
  status: ReplyDraftStatus;
  created_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  applied_at: string | null;
}

export interface InsertReplyDraftInput {
  workspaceId: string;
  platform: ReplyDraftPlatform;
  replyToUrl: string;
  replyToAuthor?: string | null;
  replyToText?: string | null;
  replyToLikes?: number | null;
  replyToReplies?: number | null;
  mode: ReplyDraftMode;
  body: string;
  alternates?: string[];
  verdict?: unknown;
  score?: number | null;
  initialStatus?: ReplyDraftStatus;
}

/**
 * Find a draft by (workspace, platform, reply_to_url). Used by schedulers
 * to dedup before spending a classifier/drafter call on a post that
 * already has a draft.
 */
export async function findReplyDraftByUrl(
  db: DatabaseAdapter,
  workspaceId: string,
  url: string,
): Promise<ReplyDraftRow | null> {
  try {
    const { data } = await db
      .from<ReplyDraftRow>('x_reply_drafts')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('reply_to_url', url)
      .limit(1);
    return data && data.length > 0 ? data[0] : null;
  } catch (err) {
    logger.warn({ err, workspaceId, url }, 'x-reply-store: findByUrl failed');
    return null;
  }
}

/**
 * Insert a draft. Returns the new row, or null when the UNIQUE
 * (workspace_id, reply_to_url) constraint fires (race-safe dedup).
 */
export async function insertReplyDraft(
  db: DatabaseAdapter,
  input: InsertReplyDraftInput,
): Promise<ReplyDraftRow | null> {
  const row: ReplyDraftRow = {
    id: randomUUID().replace(/-/g, ''),
    workspace_id: input.workspaceId,
    platform: input.platform,
    reply_to_url: input.replyToUrl,
    reply_to_author: input.replyToAuthor ?? null,
    reply_to_text: input.replyToText ?? null,
    reply_to_likes: input.replyToLikes ?? null,
    reply_to_replies: input.replyToReplies ?? null,
    mode: input.mode,
    body: input.body,
    alternates_json: input.alternates && input.alternates.length > 0
      ? JSON.stringify(input.alternates)
      : null,
    verdict_json: input.verdict !== undefined ? JSON.stringify(input.verdict) : null,
    score: input.score ?? null,
    status: input.initialStatus ?? 'pending',
    created_at: new Date().toISOString(),
    approved_at: null,
    rejected_at: null,
    applied_at: null,
  };
  try {
    const { error } = await db.from<ReplyDraftRow>('x_reply_drafts').insert(row);
    if (error) {
      logger.info({ error, url: input.replyToUrl }, 'x-reply-store: insert rejected (likely dup)');
      return null;
    }
    return row;
  } catch (err) {
    logger.warn({ err, workspaceId: input.workspaceId }, 'x-reply-store: insert threw');
    return null;
  }
}

export interface ListReplyDraftsFilters {
  platform?: ReplyDraftPlatform;
  status?: ReplyDraftStatus;
  limit?: number;
  /** When true, return only rows created on or after this ISO timestamp. */
  sinceIso?: string;
}

export async function listReplyDrafts(
  db: DatabaseAdapter,
  workspaceId: string,
  filters: ListReplyDraftsFilters = {},
): Promise<ReplyDraftRow[]> {
  try {
    let q = db
      .from<ReplyDraftRow>('x_reply_drafts')
      .select('*')
      .eq('workspace_id', workspaceId);
    if (filters.platform) q = q.eq('platform', filters.platform);
    if (filters.status) q = q.eq('status', filters.status);
    if (filters.sinceIso) q = q.gte('created_at', filters.sinceIso);
    const { data } = await q.order('created_at', { ascending: false }).limit(
      Math.min(Math.max(filters.limit ?? 50, 1), 200),
    );
    return data ?? [];
  } catch (err) {
    logger.warn({ err, workspaceId }, 'x-reply-store: list failed');
    return [];
  }
}

/**
 * Get the oldest dispatch-ready drafts (FIFO). Dispatcher consumes
 * these and posts them.
 *
 * Includes both `approved` (human-gated) and `auto_applied` (gate-
 * disabled) rows. The scheduler writes `auto_applied` directly when
 * `<platform>_reply.approval_required=false`, and the dispatcher's
 * docstring explicitly treats the two statuses identically. Missing
 * `auto_applied` here silently stalled every dispatch whenever the
 * approval gate was off.
 */
export async function listApprovedForDispatch(
  db: DatabaseAdapter,
  workspaceId: string,
  platform: ReplyDraftPlatform,
  limit = 5,
): Promise<ReplyDraftRow[]> {
  try {
    const { data } = await db
      .from<ReplyDraftRow>('x_reply_drafts')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('platform', platform)
      .in('status', ['approved', 'auto_applied'])
      .is('applied_at', null)
      .order('created_at', { ascending: true })
      .limit(Math.min(Math.max(limit, 1), 20));
    return data ?? [];
  } catch (err) {
    logger.warn({ err, workspaceId, platform }, 'x-reply-store: listApprovedForDispatch failed');
    return [];
  }
}

export async function setReplyDraftStatus(
  db: DatabaseAdapter,
  workspaceId: string,
  id: string,
  status: Exclude<ReplyDraftStatus, 'pending'>,
): Promise<ReplyDraftRow | null> {
  const now = new Date().toISOString();
  const patch: Partial<ReplyDraftRow> = { status };
  if (status === 'approved') patch.approved_at = now;
  if (status === 'rejected') patch.rejected_at = now;
  if (status === 'applied' || status === 'auto_applied') patch.applied_at = now;
  try {
    await db
      .from<ReplyDraftRow>('x_reply_drafts')
      .update(patch)
      .eq('workspace_id', workspaceId)
      .eq('id', id);
    const { data } = await db
      .from<ReplyDraftRow>('x_reply_drafts')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('id', id)
      .limit(1);
    return data && data.length > 0 ? data[0] : null;
  } catch (err) {
    logger.warn({ err, workspaceId, id, status }, 'x-reply-store: setStatus failed');
    return null;
  }
}

export async function findReplyDraftById(
  db: DatabaseAdapter,
  workspaceId: string,
  id: string,
): Promise<ReplyDraftRow | null> {
  try {
    const { data } = await db
      .from<ReplyDraftRow>('x_reply_drafts')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('id', id)
      .limit(1);
    return data && data.length > 0 ? data[0] : null;
  } catch (err) {
    logger.warn({ err, workspaceId, id }, 'x-reply-store: findById failed');
    return null;
  }
}
