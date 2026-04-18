/**
 * XReplyScheduler — 10-minute autonomous X reply pipeline.
 *
 * This scheduler no longer posts replies inline. It produces draft rows
 * in the `x_reply_drafts` table; the XReplyDispatcher consumes approved
 * rows and publishes via xPostingExecutor.
 *
 * Pipeline per tick:
 *   1. Check enablement (runtime_config `x_reply.enabled`, default true).
 *   2. Load the query set (runtime_config `x_reply.queries`, default
 *      seeded from the sandbox-validated pain-finder list). Each entry:
 *        { q, mode: 'direct' | 'viral', x_extra?, min_likes?,
 *          min_replies?, max_age_hours? }
 *   3. For each query: build a search URL with the right tab (f=live for
 *      direct, f=top for viral), scan, tag posts with mode + filters.
 *   4. Dedup against existing drafts (x_reply_drafts UNIQUE constraint
 *      is authoritative; this is just to skip classifier spend early).
 *   5. Filter + score via pickReplyTargets with per-query filter
 *      overrides and author-dedup (one post per author per tick).
 *   6. Classifier pass (direct posts only, Haiku, concurrency 8). Viral
 *      posts auto-pass with a synthetic verdict.
 *   7. For each keeper: generate a draft (mode-aware), run voice gate
 *      (with autoFixCosmetic pre-scrub).
 *   8. Insert draft into x_reply_drafts with status='pending' (or
 *      'auto_applied' when `x_reply.approval_required=false`).
 *
 * The XReplyDispatcher runs separately on a ~5-min tick, enforces the
 * daily cap + cooldown + posted-text dedup, and calls xPostingExecutor.
 *
 * CDP lane serialization: shares the Chrome profile lane with every
 * other X/Threads scheduler; the ticking guard prevents self-overlap.
 *
 * Workspace guard: designed for the `default` workspace. Other
 * workspaces wire their own if desired.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';
import { logger } from '../lib/logger.js';
import { getRuntimeConfig } from '../self-bench/runtime-config.js';
import { scanXPostsViaBrowser } from '../orchestrator/tools/x-reply.js';
import {
  pickReplyTargets,
  tweetToCandidate,
  type ReplyCandidate,
  type SelectorFilters,
} from '../orchestrator/tools/reply-target-selector.js';
import { generateReplyCopy } from '../orchestrator/tools/reply-copy-generator.js';
import {
  classifyReplyTargetsBatch,
  isKeeper,
  viralPiggybackVerdict,
  type ReplyClassifierVerdict,
} from '../orchestrator/tools/reply-target-classifier.js';
import {
  insertReplyDraft,
  findReplyDraftByUrl,
} from './x-reply-store.js';

// ---------------------------------------------------------------------------
// Runtime config keys
// ---------------------------------------------------------------------------

const CFG_ENABLED = 'x_reply.enabled';
const CFG_QUERIES = 'x_reply.queries';
const CFG_TOPN = 'x_reply.topn';
const CFG_APPROVAL_REQUIRED = 'x_reply.approval_required';

const DEFAULT_TICK_MS = 10 * 60 * 1000;
const DEFAULT_WARMUP_MS = 3.5 * 60 * 1000;
const DEFAULT_TOPN = 8;
const SCAN_LIMIT_PER_QUERY = 20;
const SCAN_SCROLL_ROUNDS = 3;
const CLASSIFIER_CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// Query shape + defaults
// ---------------------------------------------------------------------------

export interface XReplyQuery {
  q: string;
  mode: 'direct' | 'viral';
  x_extra?: string;
  min_likes?: number;
  min_replies?: number;
  max_age_hours?: number;
}

/**
 * Sandbox-validated default query set (2026-04-18). The direct phrases
 * find solopreneurs in marketing mode ("accepting new clients",
 * "taking on new clients", "open for commissions") and real operator
 * vents ("doing everything myself", "wish I could clone myself"). The
 * viral phrases pull in crowded indie-hacker threads whose reply
 * sections are packed with ohwow's ICP.
 */
export const DEFAULT_X_REPLY_QUERIES: XReplyQuery[] = [
  { q: '"now booking"', mode: 'direct', x_extra: 'lang:en -filter:replies' },
  { q: '"accepting new clients"', mode: 'direct', x_extra: 'lang:en -filter:replies' },
  { q: '"taking on new clients"', mode: 'direct', x_extra: 'lang:en -filter:replies' },
  { q: '"available for freelance"', mode: 'direct', x_extra: 'lang:en -filter:replies' },
  { q: '"looking for more clients"', mode: 'direct', x_extra: 'lang:en -filter:replies' },
  { q: '"open to projects"', mode: 'direct', x_extra: 'lang:en -filter:replies' },
  { q: '"open for commissions"', mode: 'direct', x_extra: 'lang:en -filter:replies -academic -essay' },
  { q: '"as a solopreneur"', mode: 'direct', x_extra: 'lang:en -filter:replies' },
  { q: '"hiring a VA"', mode: 'direct', x_extra: 'lang:en -filter:replies' },
  { q: '"should I hire"', mode: 'direct', x_extra: 'lang:en -filter:replies' },
  { q: '"wish I could clone myself"', mode: 'direct', x_extra: 'lang:en -filter:replies' },
  { q: '"doing everything myself"', mode: 'direct', x_extra: 'lang:en -filter:replies' },
  { q: '"solo founder"', mode: 'viral', min_likes: 50, min_replies: 10, max_age_hours: 336 },
  { q: '"build in public"', mode: 'viral', min_likes: 50, min_replies: 10, max_age_hours: 336 },
  { q: '"indie hacker"', mode: 'viral', min_likes: 20, min_replies: 5, max_age_hours: 336 },
];

/**
 * Back-compat parser. If the runtime_config value is an array of bare
 * strings (old shape), wrap each as a direct-mode query. If it's an
 * array of objects, cast and return.
 */
function normalizeQueries(raw: unknown): XReplyQuery[] {
  if (!Array.isArray(raw)) return DEFAULT_X_REPLY_QUERIES;
  const out: XReplyQuery[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      out.push({ q: entry, mode: 'direct' });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const q = typeof obj.q === 'string' ? obj.q : null;
      const modeRaw = typeof obj.mode === 'string' ? obj.mode : 'direct';
      const mode: 'direct' | 'viral' = modeRaw === 'viral' ? 'viral' : 'direct';
      if (!q) continue;
      out.push({
        q,
        mode,
        x_extra: typeof obj.x_extra === 'string' ? obj.x_extra : undefined,
        min_likes: typeof obj.min_likes === 'number' ? obj.min_likes : undefined,
        min_replies: typeof obj.min_replies === 'number' ? obj.min_replies : undefined,
        max_age_hours: typeof obj.max_age_hours === 'number' ? obj.max_age_hours : undefined,
      });
    }
  }
  return out.length > 0 ? out : DEFAULT_X_REPLY_QUERIES;
}

/**
 * Build the X search `source` string for scanXPostsViaBrowser. Direct
 * mode uses the `live` tab (fresh posts); viral uses `top` (highest
 * engagement). `x_extra` operators (e.g. "lang:en -filter:replies",
 * "within_time:2d") are appended to the query.
 */
function buildSource(q: XReplyQuery): string {
  const recencyOp = q.mode === 'viral' ? 'within_time:14d' : 'within_time:2d';
  const extras = [q.x_extra, recencyOp].filter(Boolean).join(' ');
  const fullQuery = extras ? `${q.q} ${extras}` : q.q;
  const tab = q.mode === 'viral' ? 'top' : 'live';
  return `search:${fullQuery}:${tab}`;
}

/**
 * Per-query filter set. Direct mode uses the original conservative
 * filters (drop oversaturated, drop >48h). Viral mode lifts the caps
 * and requires an engagement floor instead.
 */
function filtersFor(q: XReplyQuery): SelectorFilters {
  if (q.mode === 'viral') {
    return {
      excludeHandles: ['ohwow_fun', 'aidreammm'],
      maxLikes: Number.POSITIVE_INFINITY,
      maxReplies: Number.POSITIVE_INFINITY,
      minLikes: q.min_likes ?? 50,
      minReplies: q.min_replies ?? 10,
      maxAgeHours: q.max_age_hours ?? 14 * 24,
      minTextLength: 20,
      maxPerAuthor: 1,
    };
  }
  return {
    excludeHandles: ['ohwow_fun', 'aidreammm'],
    maxLikes: 500,
    maxReplies: 40,
    minLikes: q.min_likes ?? 0,
    minReplies: q.min_replies ?? 0,
    maxAgeHours: q.max_age_hours ?? 52,
    minTextLength: 20,
    maxPerAuthor: 1,
  };
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export interface XReplySchedulerOpts {
  db: DatabaseAdapter;
  engine: RuntimeEngine;
  workspaceId: string;
  workspaceSlug: string;
  tickIntervalMs?: number;
  warmupMs?: number;
}

interface TaggedCandidate {
  candidate: ReplyCandidate;
  query: XReplyQuery;
}

export class XReplyScheduler {
  private readonly db: DatabaseAdapter;
  private readonly engine: RuntimeEngine;
  private readonly workspaceId: string;
  private readonly workspaceSlug: string;
  private readonly tickIntervalMs: number;
  private readonly warmupMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private warmupTimer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private stopped = false;

  constructor(opts: XReplySchedulerOpts) {
    this.db = opts.db;
    this.engine = opts.engine;
    this.workspaceId = opts.workspaceId;
    this.workspaceSlug = opts.workspaceSlug;
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.warmupMs = opts.warmupMs ?? DEFAULT_WARMUP_MS;
  }

  start(): void {
    if (this.timer) return;
    logger.info(
      { tickIntervalMs: this.tickIntervalMs, warmupMs: this.warmupMs, workspace: this.workspaceSlug },
      '[x-reply-scheduler] starting',
    );
    this.warmupTimer = setTimeout(() => { void this.tick('warmup'); }, this.warmupMs);
    this.timer = setInterval(() => { void this.tick('interval'); }, this.tickIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.warmupTimer) { clearTimeout(this.warmupTimer); this.warmupTimer = null; }
    logger.info('[x-reply-scheduler] stopped');
  }

  private async tick(trigger: 'warmup' | 'interval'): Promise<void> {
    if (this.stopped) return;
    if (this.ticking) {
      logger.debug('[x-reply-scheduler] tick skipped — previous still running');
      return;
    }
    this.ticking = true;
    try {
      await this.attempt(trigger);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        '[x-reply-scheduler] tick crashed; swallowing',
      );
    } finally {
      this.ticking = false;
    }
  }

  private async attempt(trigger: 'warmup' | 'interval'): Promise<void> {
    const enabled = getRuntimeConfig<boolean>(CFG_ENABLED, true);
    if (!enabled) {
      logger.debug('[x-reply-scheduler] disabled via runtime_config');
      return;
    }

    const queries = normalizeQueries(getRuntimeConfig<unknown>(CFG_QUERIES, DEFAULT_X_REPLY_QUERIES));
    const approvalRequired = getRuntimeConfig<boolean>(CFG_APPROVAL_REQUIRED, true);
    const topN = getRuntimeConfig<number>(CFG_TOPN, DEFAULT_TOPN) || DEFAULT_TOPN;

    logger.info(
      { trigger, queries: queries.length, topN, approvalRequired },
      '[x-reply-scheduler] tick entering scan phase',
    );

    // 1. Scan — tag each candidate with its source query for per-query
    //    filter application downstream.
    const pool = await this.scanPool(queries);
    if (pool.length === 0) {
      logger.info('[x-reply-scheduler] pool empty; skipping tick');
      return;
    }

    // 2. Early dedup against already-drafted URLs (skip classifier spend).
    const draftedUrls = await this.loadDraftedUrls();
    const freshPool = pool.filter((t) => !draftedUrls.has(t.candidate.url));
    if (freshPool.length === 0) {
      logger.info('[x-reply-scheduler] all pool URLs already have drafts');
      return;
    }

    // 3. Filter + score. Run one selector per query (so filters differ per
    //    mode), then merge. Author dedup happens per-query AND globally
    //    below, so one author still can't win more than 1 slot this tick.
    const perQuerySurvivors: Array<{ candidate: ReplyCandidate; score: number; query: XReplyQuery }> = [];
    for (const q of queries) {
      const qPool = freshPool.filter((t) => t.query.q === q.q).map((t) => t.candidate);
      if (qPool.length === 0) continue;
      const sel = pickReplyTargets({
        candidates: qPool,
        filters: filtersFor(q),
        topicKeywords: [], // classifier replaces topic gating
        topN: 100,
      });
      for (const s of sel.accepted) {
        perQuerySurvivors.push({ candidate: s.candidate, score: s.score, query: q });
      }
    }
    if (perQuerySurvivors.length === 0) {
      logger.info('[x-reply-scheduler] no posts survived per-query filters');
      return;
    }

    // 4. Global author dedup across queries.
    const seenAuthors = new Set<string>();
    perQuerySurvivors.sort((a, b) => b.score - a.score);
    const crossDedup = perQuerySurvivors.filter((s) => {
      const key = (s.candidate.authorHandle || 'unknown').toLowerCase();
      if (seenAuthors.has(key)) return false;
      seenAuthors.add(key);
      return true;
    });
    logger.info(
      { perQuery: perQuerySurvivors.length, dedupd: crossDedup.length },
      '[x-reply-scheduler] survivors after cross-author dedup',
    );

    // 5. Classifier — direct-mode only. Viral posts auto-pass.
    //    Cap classifier budget at 3× topN so we don't spend on an entire
    //    batch when only a few will be drafted.
    const classifyBudget = Math.min(crossDedup.length, topN * 3);
    const toClassify = crossDedup.slice(0, classifyBudget);
    const directPosts = toClassify.filter((s) => s.query.mode === 'direct');
    const viralPosts = toClassify.filter((s) => s.query.mode === 'viral');

    const directVerdicts = directPosts.length > 0
      ? await classifyReplyTargetsBatch(
          { db: this.db, engine: this.engine, workspaceId: this.workspaceId },
          directPosts.map((s) => s.candidate),
          CLASSIFIER_CONCURRENCY,
        )
      : [];

    const keepers: Array<{ candidate: ReplyCandidate; score: number; query: XReplyQuery; verdict: ReplyClassifierVerdict }> = [];
    for (let i = 0; i < directPosts.length; i++) {
      const verdict = directVerdicts[i];
      if (isKeeper(verdict)) {
        keepers.push({ ...directPosts[i], verdict });
      }
    }
    for (const vp of viralPosts) {
      keepers.push({ ...vp, verdict: viralPiggybackVerdict(vp.candidate) });
    }
    keepers.sort((a, b) => b.score - a.score);

    logger.info(
      { classified: directPosts.length, viralAutoPass: viralPosts.length, keepers: keepers.length },
      '[x-reply-scheduler] classifier results',
    );
    if (keepers.length === 0) return;

    // 6. Draft top-N keepers and insert into x_reply_drafts.
    const toDraft = keepers.slice(0, topN);
    let inserted = 0;
    for (const k of toDraft) {
      // Belt-and-suspenders dedup — cheap if draftedUrls caught it, but
      // the scan window is wide and a concurrent tick could have inserted.
      const existing = await findReplyDraftByUrl(this.db, this.workspaceId, k.candidate.url);
      if (existing) continue;

      const gen = await generateReplyCopy(
        { db: this.db, engine: this.engine, workspaceId: this.workspaceId },
        { target: k.candidate, platform: 'x', mode: k.query.mode },
      );
      if (!gen.ok) {
        logger.warn({ err: gen.error, url: k.candidate.url }, '[x-reply-scheduler] generator failed');
        continue;
      }
      if (gen.draft === 'SKIP') {
        logger.info(
          { url: k.candidate.url, rationale: gen.rationale },
          '[x-reply-scheduler] candidate skipped by generator',
        );
        continue;
      }

      const row = await insertReplyDraft(this.db, {
        workspaceId: this.workspaceId,
        platform: 'x',
        replyToUrl: k.candidate.url,
        replyToAuthor: k.candidate.authorHandle,
        replyToText: k.candidate.text,
        replyToLikes: k.candidate.likes,
        replyToReplies: k.candidate.replies,
        mode: k.query.mode,
        body: gen.draft!,
        alternates: gen.alternates,
        verdict: k.verdict,
        score: k.score,
        initialStatus: approvalRequired ? 'pending' : 'auto_applied',
      });
      if (row) {
        inserted++;
        logger.info(
          { id: row.id, url: k.candidate.url, mode: k.query.mode, score: k.score, approvalRequired },
          '[x-reply-scheduler] draft inserted',
        );
      }
    }
    logger.info({ inserted, drafted: toDraft.length }, '[x-reply-scheduler] tick complete');
  }

  // ---- helpers ----

  private async scanPool(queries: XReplyQuery[]): Promise<TaggedCandidate[]> {
    const pool: TaggedCandidate[] = [];
    const seenByPermalink = new Set<string>();
    for (const q of queries) {
      try {
        const res = await scanXPostsViaBrowser({
          source: buildSource(q),
          limit: SCAN_LIMIT_PER_QUERY,
          scrollRounds: SCAN_SCROLL_ROUNDS,
        });
        if (!res.success) {
          logger.warn({ q: q.q, message: res.message }, '[x-reply-scheduler] scan returned failure');
          continue;
        }
        for (const t of res.tweets.map(tweetToCandidate)) {
          if (seenByPermalink.has(t.id)) continue;
          seenByPermalink.add(t.id);
          pool.push({ candidate: t, query: q });
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err, q: q.q },
          '[x-reply-scheduler] scan query failed',
        );
      }
    }
    return pool;
  }

  private async loadDraftedUrls(): Promise<Set<string>> {
    // Any draft for this workspace+platform, any status — we never want to
    // re-draft the same target post. UNIQUE constraint in the table is the
    // source of truth; this early-exit just saves classifier spend.
    try {
      const { data } = await this.db
        .from<{ reply_to_url: string }>('x_reply_drafts')
        .select('reply_to_url')
        .eq('workspace_id', this.workspaceId)
        .eq('platform', 'x');
      const rows = Array.isArray(data) ? data : [];
      return new Set(rows.map((r) => r.reply_to_url).filter(Boolean));
    } catch {
      return new Set<string>();
    }
  }
}
