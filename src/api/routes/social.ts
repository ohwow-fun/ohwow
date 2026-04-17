/**
 * Social Routes
 * GET /api/social/posts — unified feed of posted X/Threads content (posts + replies)
 *
 * Reads `posted_log` (migration 133) — the source of truth for "this text
 * actually left the machine". The Marketing page reads
 * agent_workforce_deliverables, which captures drafts at the orchestrator
 * layer and can't distinguish a queued draft from one that actually
 * published; this route is the post-publish view.
 *
 * Engagement enrichment: best-effort join with the JSONL produced by
 * scripts/x-experiments/x-own-engagement.mjs (at
 * ~/.ohwow/workspaces/<ws>/x-own-posts.jsonl). Rows without a matching
 * snapshot just return `engagement: null`. When permalink-at-publish
 * capture lands, we'll replace the JSONL hash-match with a direct
 * posted_log.post_url join.
 */

import { Router } from 'express';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { resolveActiveWorkspace } from '../../config.js';
import { logger } from '../../lib/logger.js';

type Platform = 'x' | 'threads';
type Kind = 'post' | 'reply';

interface PostedLogRow {
  id: string;
  workspace_id: string;
  platform: string;
  text_hash: string;
  text_preview: string;
  text_length: number;
  posted_at: string;
  approval_id: string | null;
  task_id: string | null;
  source: string | null;
}

interface EngagementSnapshot {
  likes: number;
  replies: number;
  reposts: number;
  views: number;
  permalink: string;
  last_seen_at: string;
}

/** SHA-256 of the normalized form — must match hashPostText in posted-text-log.ts */
function hashNormalized(raw: string): string {
  const normalized = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Load the own-posts JSONL produced by x-own-engagement.mjs, keep the
 * latest snapshot per normalized-text-hash. Silently returns an empty
 * map when the file doesn't exist (operator hasn't run the harvester
 * yet — every snapshot is still loaded JIT per request since the
 * file is small and rewriting on every row read doesn't justify a
 * cache/invalidation layer at current volumes).
 */
function loadOwnEngagementByHash(): Map<string, EngagementSnapshot> {
  const out = new Map<string, EngagementSnapshot>();
  const ws = resolveActiveWorkspace();
  const jsonlPath = `${ws.dataDir}/x-own-posts.jsonl`;
  if (!fs.existsSync(jsonlPath)) return out;
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf-8');
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : err }, '[social] read jsonl failed');
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row: {
      ts?: string;
      permalink?: string;
      text?: string;
      likes?: number;
      replies?: number;
      reposts?: number;
      views?: number;
    };
    try { row = JSON.parse(line); } catch { continue; }
    if (!row.text || !row.permalink) continue;
    const hash = hashNormalized(row.text);
    const existing = out.get(hash);
    if (!existing || (row.ts && row.ts > existing.last_seen_at)) {
      out.set(hash, {
        likes: row.likes ?? 0,
        replies: row.replies ?? 0,
        reposts: row.reposts ?? 0,
        views: row.views ?? 0,
        permalink: row.permalink,
        last_seen_at: row.ts ?? '',
      });
    }
  }
  return out;
}

function parseSource(source: string | null): { kind: Kind; replyToUrl: string | null } {
  if (!source) return { kind: 'post', replyToUrl: null };
  if (source.startsWith('reply_to:')) {
    return { kind: 'reply', replyToUrl: source.slice('reply_to:'.length) || null };
  }
  return { kind: 'post', replyToUrl: null };
}

function isValidPlatform(v: unknown): v is Platform | 'all' {
  return v === 'x' || v === 'threads' || v === 'all' || v === undefined;
}
function isValidKind(v: unknown): v is Kind | 'all' {
  return v === 'post' || v === 'reply' || v === 'all' || v === undefined;
}

export function createSocialRouter(db: DatabaseAdapter): Router {
  const router = Router();

  router.get('/api/social/posts', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { platform, kind, limit = '50', offset = '0' } = req.query;

      if (!isValidPlatform(platform)) {
        res.status(400).json({ error: 'platform must be x|threads|all' });
        return;
      }
      if (!isValidKind(kind)) {
        res.status(400).json({ error: 'kind must be post|reply|all' });
        return;
      }

      const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 50, 1), 200);
      const parsedOffset = Math.max(0, parseInt(offset as string, 10) || 0);

      // Aggregate counts for filter tabs. The workspace slice is small
      // enough (thousands of rows, not millions) that loading the
      // platform/source columns for every row in-memory is cheaper
      // than five separate COUNT(*) queries.
      const { data: allData } = await db.from<{ platform: string; source: string | null }>('posted_log')
        .select('platform, source')
        .eq('workspace_id', workspaceId);
      const allRows = (allData ?? []) as Array<{ platform: string; source: string | null }>;
      const platformCounts: Record<string, number> = { x: 0, threads: 0 };
      const kindCounts: Record<string, number> = { post: 0, reply: 0 };
      for (const r of allRows) {
        if (r.platform in platformCounts) platformCounts[r.platform]++;
        const parsed = parseSource(r.source);
        kindCounts[parsed.kind]++;
      }

      // Row query with filters
      let query = db.from<PostedLogRow>('posted_log')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('posted_at', { ascending: false });

      if (platform && platform !== 'all') query = query.eq('platform', platform);

      // kind=post → source NOT starting with 'reply_to:'; adapter has no
      // NOT LIKE, so we fetch a slightly wider window and filter in-memory
      // below. For large volumes this would need a source_kind column or
      // a different adapter feature — at current volumes (weeks of data),
      // fetching 3× page size and trimming is deterministic and simple.
      const overfetch = parsedLimit * 3;
      query = query.range(parsedOffset, parsedOffset + overfetch - 1);

      const { data, error } = await query;
      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }
      const fetched = (data ?? []) as PostedLogRow[];

      // Apply kind filter in-memory
      const kindFiltered = (kind && kind !== 'all')
        ? fetched.filter((r) => parseSource(r.source).kind === kind)
        : fetched;

      const windowed = kindFiltered.slice(0, parsedLimit);

      // total after filters — recompute from the full-column aggregate
      // so pagination's 'show more' is honest.
      const total = allRows.filter((r) => {
        if (platform && platform !== 'all' && r.platform !== platform) return false;
        if (kind && kind !== 'all' && parseSource(r.source).kind !== kind) return false;
        return true;
      }).length;

      // Task title lookup
      const taskIds = [...new Set(windowed.map((r) => r.task_id).filter(Boolean))] as string[];
      const taskMap = new Map<string, string>();
      if (taskIds.length > 0) {
        const { data: tasks } = await db.from<{ id: string; title: string }>('agent_workforce_tasks')
          .select('id, title')
          .in('id', taskIds);
        for (const t of (tasks ?? []) as Array<{ id: string; title: string }>) {
          taskMap.set(t.id, t.title);
        }
      }

      // Engagement join (best effort, empty map if harvester hasn't run)
      const engagementByHash = loadOwnEngagementByHash();

      const enriched = windowed.map((row) => {
        const { kind: k, replyToUrl } = parseSource(row.source);
        const eng = engagementByHash.get(row.text_hash) ?? null;
        return {
          id: row.id,
          platform: row.platform,
          kind: k,
          text_preview: row.text_preview,
          text_length: row.text_length,
          text_hash: row.text_hash,
          posted_at: row.posted_at,
          source: row.source,
          reply_to_url: replyToUrl,
          approval_id: row.approval_id,
          task_id: row.task_id,
          task_title: row.task_id ? (taskMap.get(row.task_id) ?? null) : null,
          engagement: eng,
        };
      });

      res.json({
        data: enriched,
        total,
        limit: parsedLimit,
        offset: parsedOffset,
        platformCounts,
        kindCounts,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
