/**
 * posted-text-log — durable dedup primitive for the X posting path.
 *
 * Every successful publish appends one row to x_posted_log (migration 129).
 * Two consumers:
 *
 *   1. Pre-flight gate in postTweetHandler. Hash the candidate bytes,
 *      look them up. If a matching row exists within the lookback
 *      window, skip the compose modal entirely — X would reject the
 *      content with "you already said that" anyway; no point burning
 *      a CDP lane slot.
 *
 *   2. Draft-picker filter in selectApprovedDraft. When the operator
 *      re-approves a draft whose text is already in the log (happens
 *      when the LLM author drafts the same opener across ticks), the
 *      picker skips it and advances to the next candidate.
 *
 * Normalization
 * -------------
 * The hash is SHA-256 over the normalized form — lowercased, whitespace
 * collapsed, leading/trailing trimmed. This makes "Hello world!" and
 * "hello  world!" collide, which matches how X's own duplicate gate
 * appears to judge near-identical posts. A stricter (exact-bytes) hash
 * would let tiny edits bypass the gate and still get rejected by X.
 */

import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from './logger.js';

/** Default window the pre-flight check scans. 30d comfortably
 * exceeds X's observed duplicate-content cooldown. */
export const DEFAULT_POSTED_LOG_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function normalizePostText(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function hashPostText(raw: string): string {
  return crypto.createHash('sha256').update(normalizePostText(raw)).digest('hex');
}

interface PostedLogRow {
  id: string;
  workspace_id: string;
  text_hash: string;
  text_preview: string;
  posted_at: string;
  approval_id: string | null;
  task_id: string | null;
  source: string | null;
}

export interface RecordPostedInput {
  db: DatabaseAdapter;
  workspaceId: string;
  text: string;
  approvalId?: string | null;
  taskId?: string | null;
  source?: string;
}

/**
 * Insert a posted-text row. Swallows UNIQUE-constraint violations
 * silently — a duplicate-text insert is exactly the case the table
 * models (the caller already posted this, we just didn't catch it at
 * the pre-flight layer). Never throws.
 */
export async function recordPostedText(input: RecordPostedInput): Promise<void> {
  const { db, workspaceId, text } = input;
  const hash = hashPostText(text);
  const preview = text.slice(0, 240);
  try {
    const { error } = await db.from('x_posted_log').insert({
      workspace_id: workspaceId,
      text_hash: hash,
      text_preview: preview,
      text_length: text.length,
      posted_at: new Date().toISOString(),
      approval_id: input.approvalId ?? null,
      task_id: input.taskId ?? null,
      source: input.source ?? null,
    });
    if (error) {
      const msg = (error as { message?: string }).message ?? String(error);
      if (/UNIQUE|constraint/i.test(msg)) return;
      logger.warn({ err: error, workspaceId, hash }, '[posted-text-log] insert error');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|constraint/i.test(msg)) return;
    logger.warn({ err, workspaceId }, '[posted-text-log] insert threw');
  }
}

export interface PostedLookupResult {
  alreadyPosted: boolean;
  postedAt?: string;
  approvalId?: string | null;
  taskId?: string | null;
}

/**
 * Check whether the normalized form of `text` has been posted inside
 * the rolling window. Returns {alreadyPosted: false} on DB error so a
 * transient failure doesn't indefinitely block new posts. That's an
 * intentional asymmetry with outreach-policy's fail-closed: the worst
 * case here is a lap around the compose modal + X's own duplicate
 * gate catching it, which is visible in logs; the worst case there
 * is sending two outbound messages to the same human.
 */
export async function hasRecentlyPostedText(
  db: DatabaseAdapter,
  workspaceId: string,
  text: string,
  windowMs: number = DEFAULT_POSTED_LOG_WINDOW_MS,
): Promise<PostedLookupResult> {
  const hash = hashPostText(text);
  const cutoffIso = new Date(Date.now() - windowMs).toISOString();
  try {
    const { data } = await db
      .from<PostedLogRow>('x_posted_log')
      .select('id, workspace_id, text_hash, text_preview, posted_at, approval_id, task_id, source')
      .eq('workspace_id', workspaceId)
      .eq('text_hash', hash)
      .gte('posted_at', cutoffIso)
      .limit(1);
    const rows = (data ?? []) as PostedLogRow[];
    if (rows.length === 0) return { alreadyPosted: false };
    const [row] = rows;
    return {
      alreadyPosted: true,
      postedAt: row.posted_at,
      approvalId: row.approval_id,
      taskId: row.task_id,
    };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, workspaceId },
      '[posted-text-log] lookup failed; treating as not-posted',
    );
    return { alreadyPosted: false };
  }
}

/**
 * Read the N most recent posted rows for a workspace. Used by
 * authoring/compose paths to steer away from near-recent shapes when
 * they draft the next candidate. Returns previews only (no full body)
 * since the typical caller just wants a "don't repeat these" hint
 * list, and previews keep the prompt/context small.
 */
export async function recentPostedPreviews(
  db: DatabaseAdapter,
  workspaceId: string,
  limit = 20,
): Promise<Array<{ preview: string; postedAt: string }>> {
  try {
    const { data } = await db
      .from<PostedLogRow>('x_posted_log')
      .select('text_preview, posted_at')
      .eq('workspace_id', workspaceId)
      .order('posted_at', { ascending: false })
      .limit(limit);
    const rows = (data ?? []) as Array<{ text_preview: string; posted_at: string }>;
    return rows.map((r) => ({ preview: r.text_preview, postedAt: r.posted_at }));
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, workspaceId },
      '[posted-text-log] recentPostedPreviews failed',
    );
    return [];
  }
}
