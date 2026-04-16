/**
 * patches-attempted-log — durable "don't re-try the same patch shape"
 * primitive for the autonomous author.
 *
 * Without this log a patch that Layer 5 reverted can come straight back
 * on the next patch-author tick: the finding is still unpatched, the
 * LLM emits the same bytes against the same file(s), safeSelfCommit
 * lands the same change, Layer 5 reverts it again. The model budget
 * burns on the same ill-posed attempt forever.
 *
 * Every autonomous commit records a row here (outcome='pending'). Layer
 * 5's auto-revert path flips the outcome to 'reverted' when it fires.
 * The patch-author pre-flight consults `hasRecentlyRevertedPatch` to
 * refuse proposals whose (finding, file-shape) hash matches a recent
 * revert. 14d is comfortably longer than the finding's staleness window
 * (7d) and matches the "reflect before retrying" cadence we want.
 *
 * Shape-hash design: the hash is SHA-256 over a sorted JSON array of
 * normalized forward-slashed file paths. A reverted patch on
 * ['src/web/src/pages/Agents.tsx'] does NOT block a future patch on
 * ['src/web/src/pages/Dashboard.tsx'] even if the finding is the same —
 * the model genuinely tries a different surface. A pure retry on the
 * same files collides.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from './logger.js';

/** How long a 'reverted' row stays "don't retry this" in patch-author's pre-flight. */
export const REVERTED_PATCH_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

export type PatchOutcome = 'pending' | 'held' | 'reverted';

export interface PatchAttemptRow {
  id: string;
  workspace_id: string;
  finding_id: string;
  file_paths_hash: string;
  commit_sha: string | null;
  outcome: PatchOutcome;
  proposed_at: string;
  resolved_at: string | null;
  patch_mode: string | null;
  tier: string | null;
}

/**
 * Normalize a file path for hashing. Forward slashes, no leading slash,
 * trimmed whitespace. Matches the conventions already in use across
 * path-trust-tiers.ts so the hash agrees regardless of how the caller
 * produced the path list.
 */
export function normalizeHashPath(p: string): string {
  return path.normalize(p).replace(/\\/g, '/').trim();
}

/**
 * Produce a stable shape hash for a list of file paths. Paths are
 * normalized, deduped, sorted ascending, then JSON.stringified and
 * SHA-256'd. Stable across call order — the same set of paths yields
 * the same hash regardless of which order the caller passed them in.
 */
export function hashFilePaths(paths: readonly string[]): string {
  const normalized = [...new Set(paths.map(normalizeHashPath))].sort();
  const json = JSON.stringify(normalized);
  return crypto.createHash('sha256').update(json).digest('hex');
}

export interface RecordAttemptInput {
  db: DatabaseAdapter;
  workspaceId: string;
  findingId: string;
  filePaths: readonly string[];
  commitSha?: string | null;
  patchMode?: string | null;
  tier?: string | null;
}

/**
 * Insert a pending attempt row. Idempotent on (workspace, finding,
 * file-shape) via the UNIQUE constraint — duplicate retries silently
 * no-op rather than throwing. Returns the shape hash so callers can
 * cross-reference later outcome updates.
 */
export async function recordProposedPatch(
  input: RecordAttemptInput,
): Promise<{ fileHash: string; wroteNewRow: boolean }> {
  const fileHash = hashFilePaths(input.filePaths);
  try {
    const { error } = await input.db.from('patches_attempted_log').insert({
      workspace_id: input.workspaceId,
      finding_id: input.findingId,
      file_paths_hash: fileHash,
      commit_sha: input.commitSha ?? null,
      outcome: 'pending',
      proposed_at: new Date().toISOString(),
      resolved_at: null,
      patch_mode: input.patchMode ?? null,
      tier: input.tier ?? null,
    });
    if (error) {
      const msg = (error as { message?: string }).message ?? String(error);
      if (/UNIQUE|constraint/i.test(msg)) {
        return { fileHash, wroteNewRow: false };
      }
      logger.warn({ err: error, workspaceId: input.workspaceId, fileHash }, '[patches-attempted-log] insert error');
      return { fileHash, wroteNewRow: false };
    }
    return { fileHash, wroteNewRow: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|constraint/i.test(msg)) return { fileHash, wroteNewRow: false };
    logger.warn({ err, workspaceId: input.workspaceId }, '[patches-attempted-log] insert threw');
    return { fileHash, wroteNewRow: false };
  }
}

/**
 * Transition a logged attempt's outcome. Called by Layer 5 auto-revert
 * (`outcome='reverted'`) and by a future validation-pass hook
 * (`outcome='held'`). Safe to call repeatedly — the final UPDATE just
 * refreshes resolved_at. Never throws.
 */
export async function updateAttemptOutcome(
  db: DatabaseAdapter,
  params: {
    workspaceId: string;
    findingId: string;
    fileHash: string;
    outcome: PatchOutcome;
    commitSha?: string | null;
  },
): Promise<void> {
  try {
    const update: Record<string, unknown> = {
      outcome: params.outcome,
      resolved_at: params.outcome === 'pending' ? null : new Date().toISOString(),
    };
    if (params.commitSha !== undefined) update.commit_sha = params.commitSha;
    await db
      .from('patches_attempted_log')
      .update(update)
      .eq('workspace_id', params.workspaceId)
      .eq('finding_id', params.findingId)
      .eq('file_paths_hash', params.fileHash);
  } catch (err) {
    logger.warn({ err, ...params }, '[patches-attempted-log] update threw');
  }
}

/**
 * Transition every attempt row tagged with a given commit SHA. Used by
 * Layer 5's auto-revert path — the caller only knows the SHA it's
 * reverting, not the finding/file-hash tuple. Falls back to a no-op on
 * error so a broken log never blocks the revert itself.
 */
export async function markCommitReverted(
  db: DatabaseAdapter,
  workspaceId: string,
  commitSha: string,
): Promise<void> {
  try {
    await db
      .from('patches_attempted_log')
      .update({ outcome: 'reverted', resolved_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId)
      .eq('commit_sha', commitSha);
  } catch (err) {
    logger.warn({ err, workspaceId, commitSha }, '[patches-attempted-log] markCommitReverted threw');
  }
}

export interface PatchAttemptedLookup {
  alreadyReverted: boolean;
  lastAttemptAt?: string;
  commitSha?: string | null;
  outcome?: PatchOutcome;
}

/**
 * Check whether the (finding, file-shape) tuple has a reverted row
 * inside the lookback window. Returns `alreadyReverted: false` on DB
 * error so a transient read failure doesn't permanently block patching.
 * The worst case of a missed lookup is the author takes one more swing
 * at a failing patch — Layer 5 still reverts it, and the next tick's
 * lookup catches the (now-written) row. The worst case of a
 * fail-closed here is the author never retries after an upstream
 * sqlite hiccup, which silently freezes the loop.
 */
export async function hasRecentlyRevertedPatch(
  db: DatabaseAdapter,
  workspaceId: string,
  findingId: string,
  filePaths: readonly string[],
  lookbackMs: number = REVERTED_PATCH_LOOKBACK_MS,
): Promise<PatchAttemptedLookup> {
  const fileHash = hashFilePaths(filePaths);
  const cutoffIso = new Date(Date.now() - lookbackMs).toISOString();
  try {
    const { data } = await db
      .from<PatchAttemptRow>('patches_attempted_log')
      .select('outcome, proposed_at, commit_sha')
      .eq('workspace_id', workspaceId)
      .eq('finding_id', findingId)
      .eq('file_paths_hash', fileHash)
      .eq('outcome', 'reverted')
      .gte('proposed_at', cutoffIso)
      .limit(1);
    const rows = (data ?? []) as Array<Pick<PatchAttemptRow, 'outcome' | 'proposed_at' | 'commit_sha'>>;
    if (rows.length === 0) return { alreadyReverted: false };
    const [row] = rows;
    return {
      alreadyReverted: true,
      lastAttemptAt: row.proposed_at,
      commitSha: row.commit_sha,
      outcome: row.outcome,
    };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, workspaceId, findingId, fileHash },
      '[patches-attempted-log] lookup failed; treating as not-reverted',
    );
    return { alreadyReverted: false };
  }
}

/**
 * Return the N most recent revert rows for a workspace. The context
 * pack's `patches-attempted` section consumes this so the LLM sees
 * "here's what we tried that didn't stick" before drafting a new
 * attempt. Returns an empty array on error.
 */
export async function recentRevertedAttempts(
  db: DatabaseAdapter,
  workspaceId: string,
  limit = 10,
): Promise<Array<{
  findingId: string;
  fileHash: string;
  commitSha: string | null;
  proposedAt: string;
  resolvedAt: string | null;
  patchMode: string | null;
}>> {
  try {
    const { data } = await db
      .from<PatchAttemptRow>('patches_attempted_log')
      .select('finding_id, file_paths_hash, commit_sha, proposed_at, resolved_at, patch_mode')
      .eq('workspace_id', workspaceId)
      .eq('outcome', 'reverted')
      .order('proposed_at', { ascending: false })
      .limit(limit);
    const rows = (data ?? []) as Array<Pick<PatchAttemptRow, 'finding_id' | 'file_paths_hash' | 'commit_sha' | 'proposed_at' | 'resolved_at' | 'patch_mode'>>;
    return rows.map((r) => ({
      findingId: r.finding_id,
      fileHash: r.file_paths_hash,
      commitSha: r.commit_sha,
      proposedAt: r.proposed_at,
      resolvedAt: r.resolved_at,
      patchMode: r.patch_mode,
    }));
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, workspaceId },
      '[patches-attempted-log] recentRevertedAttempts failed',
    );
    return [];
  }
}
