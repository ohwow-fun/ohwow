/**
 * posted-log-helpers.ts — deterministic dedup + provenance for X/Threads
 * reply and post publishing.
 *
 * Every successful publish lands a row in `posted_log` (platform,
 * text_hash, text_preview, text_length, posted_at, source). Callers
 * that are about to publish can ask `hasIdenticalPublished` first to
 * skip duplicates. `recordPost` writes the row after a confirmed
 * publish — do it inside the same try/finally that verifies the
 * publish actually landed.
 *
 * Why deterministic matters: the previous two duplicate replies on
 * @robin.ebers's post happened because the publish path's success
 * check returned a false negative (textbox-still-present → "didn't
 * clear"), causing a retry that actually republished. Without a
 * source-of-truth gate, the retry succeeded. posted_log IS that
 * source of truth.
 */

import { createHash } from 'node:crypto';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';

export type PostedPlatform = 'x' | 'threads';

export interface PostedLogRow {
  platform: PostedPlatform;
  textHash: string;
  textPreview: string;
  textLength: number;
  /** Typically 'reply_to:<url>' for reply tools, 'post' for top-level. */
  source: string;
  approvalId?: string;
  taskId?: string;
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * True when a row with the same (platform, text_hash, source) triple
 * already exists. Safe default on DB errors: returns false so callers
 * don't silently skip everything when the DB is momentarily unavailable.
 */
export async function hasIdenticalPublished(
  db: DatabaseAdapter,
  platform: PostedPlatform,
  textHash: string,
  source: string,
): Promise<boolean> {
  try {
    const { data } = await db
      .from<{ id: string }>('posted_log')
      .select('id')
      .eq('platform', platform)
      .eq('text_hash', textHash)
      .eq('source', source)
      .limit(1);
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, platform, source: source.slice(0, 60) },
      '[posted-log] hasIdenticalPublished query failed; assuming no duplicate',
    );
    return false;
  }
}

/**
 * Insert a row into posted_log. Best-effort: logs but does not throw
 * on failure. `workspaceId` is taken from `agent_workforce_workspaces`
 * — if a concrete id isn't already threaded through, pass null and we
 * resolve it positionally (matches the daemon-consolidation pattern,
 * no literal 'local' hardcoding).
 */
export async function recordPost(
  db: DatabaseAdapter,
  workspaceId: string | null,
  row: PostedLogRow,
): Promise<void> {
  try {
    let wsId = workspaceId;
    if (!wsId) {
      const { data } = await db
        .from<{ id: string }>('agent_workforce_workspaces')
        .select('id')
        .limit(1);
      wsId = Array.isArray(data) && data[0] ? data[0].id : null;
    }
    if (!wsId) {
      logger.warn('[posted-log] no workspace row available — skipping posted_log insert');
      return;
    }
    await db.from('posted_log').insert({
      workspace_id: wsId,
      platform: row.platform,
      text_hash: row.textHash,
      text_preview: row.textPreview.slice(0, 500),
      text_length: row.textLength,
      source: row.source,
      approval_id: row.approvalId ?? null,
      task_id: row.taskId ?? null,
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, source: row.source.slice(0, 80) },
      '[posted-log] recordPost insert failed',
    );
  }
}
