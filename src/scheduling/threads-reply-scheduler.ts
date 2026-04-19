/**
 * ThreadsReplyScheduler — 10-minute autonomous Threads reply pipeline.
 *
 * Mirrors XReplyScheduler but direct-mode only (Threads has no `f=top`
 * equivalent search tab for viral-piggyback mode, per v1 decision).
 *
 * Produces draft rows in `x_reply_drafts` (platform='threads'); the
 * ThreadsReplyDispatcher consumes approved rows and publishes via
 * threadsPostingExecutor.
 *
 * Per tick:
 *   1. Check enablement (`threads_reply.enabled`, default true).
 *   2. Load queries (`threads_reply.queries`, default seeded from the
 *      sandbox direct-ICP set).
 *   3. Scan each query via scanThreadsPostsViaBrowser.
 *   4. Dedup against existing drafts.
 *   5. Filter + score via pickReplyTargets (per-query filters).
 *   6. Classifier pass (all direct mode on Threads).
 *   7. For each keeper: enrich via fetchThreadsPostFullText, draft
 *      (direct mode), voice-gate, insert into x_reply_drafts.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';
import { logger } from '../lib/logger.js';
import { getRuntimeConfig } from '../self-bench/runtime-config.js';
import {
  scanThreadsPostsViaBrowser,
  fetchThreadsPostFullText,
} from '../orchestrator/tools/threads-reply.js';
import {
  pickReplyTargets,
  threadToCandidate,
  type ReplyCandidate,
  type SelectorFilters,
} from '../orchestrator/tools/reply-target-selector.js';
import { generateReplyCopy, drafterModeForClass } from '../orchestrator/tools/reply-copy-generator.js';
import {
  classifyReplyTargetsBatch,
  isKeeper,
  type ReplyClassifierVerdict,
} from '../orchestrator/tools/reply-target-classifier.js';
import {
  insertReplyDraft,
  findReplyDraftByUrl,
} from './x-reply-store.js';
import { voiceCheck, autoFixCosmetic } from '../lib/voice/voice-core.js';
import { threadsThrottleTracker } from '../lib/x-search-throttle.js';

// ---------------------------------------------------------------------------
// Runtime config keys
// ---------------------------------------------------------------------------

const CFG_ENABLED = 'threads_reply.enabled';
const CFG_QUERIES = 'threads_reply.queries';
const CFG_TOPN = 'threads_reply.topn';
const CFG_APPROVAL_REQUIRED = 'threads_reply.approval_required';

const DEFAULT_TICK_MS = 10 * 60 * 1000;
const DEFAULT_WARMUP_MS = 2 * 60 * 1000;
const DEFAULT_TOPN = 6;
const SCAN_LIMIT_PER_QUERY = 20;
const SCAN_SCROLL_ROUNDS = 3;
const CLASSIFIER_CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// Query shape + defaults
// ---------------------------------------------------------------------------

export interface ThreadsReplyQuery {
  q: string;
  /** Direct-only for Threads v1. Retained for schema parity with X. */
  mode: 'direct';
  min_likes?: number;
  min_replies?: number;
  max_age_hours?: number;
}

/**
 * Default direct-ICP query set for Threads — mirrors the re-tuned X
 * direct queries (see x-reply-scheduler.ts for the "automatable hire"
 * lens + the supplier-pitch vs first-person rationale). Threads'
 * search tab has no `top` sort, so viral-piggyback queries are
 * deferred to a future iteration.
 */
export const DEFAULT_THREADS_REPLY_QUERIES: ThreadsReplyQuery[] = [
  // First-person-forced hiring intent
  { q: "I'm looking to hire", mode: 'direct' },
  { q: 'I want to hire', mode: 'direct' },
  { q: 'I need a virtual assistant', mode: 'direct' },
  // Role-specific
  { q: 'hiring a virtual assistant', mode: 'direct' },
  { q: 'looking for a video editor', mode: 'direct' },
  { q: 'hiring a video editor', mode: 'direct' },
  { q: 'need a social media manager', mode: 'direct' },
  // Decision-point vents
  { q: 'should I hire', mode: 'direct' },
  { q: 'wish I could clone myself', mode: 'direct' },
  { q: 'doing everything myself', mode: 'direct' },
];

function normalizeQueries(raw: unknown): ThreadsReplyQuery[] {
  if (!Array.isArray(raw)) return DEFAULT_THREADS_REPLY_QUERIES;
  const out: ThreadsReplyQuery[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      out.push({ q: entry, mode: 'direct' });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const q = typeof obj.q === 'string' ? obj.q : null;
      if (!q) continue;
      out.push({
        q,
        mode: 'direct',
        min_likes: typeof obj.min_likes === 'number' ? obj.min_likes : undefined,
        min_replies: typeof obj.min_replies === 'number' ? obj.min_replies : undefined,
        max_age_hours: typeof obj.max_age_hours === 'number' ? obj.max_age_hours : undefined,
      });
    }
  }
  return out.length > 0 ? out : DEFAULT_THREADS_REPLY_QUERIES;
}

function filtersFor(q: ThreadsReplyQuery): SelectorFilters {
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

export interface ThreadsReplySchedulerOpts {
  db: DatabaseAdapter;
  engine: RuntimeEngine;
  workspaceId: string;
  workspaceSlug: string;
  tickIntervalMs?: number;
  warmupMs?: number;
}

interface TaggedCandidate {
  candidate: ReplyCandidate;
  query: ThreadsReplyQuery;
}

export class ThreadsReplyScheduler {
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

  constructor(opts: ThreadsReplySchedulerOpts) {
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
      '[threads-reply-scheduler] starting',
    );
    this.warmupTimer = setTimeout(() => { void this.tick('warmup'); }, this.warmupMs);
    this.timer = setInterval(() => { void this.tick('interval'); }, this.tickIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.warmupTimer) { clearTimeout(this.warmupTimer); this.warmupTimer = null; }
    logger.info('[threads-reply-scheduler] stopped');
  }

  private async tick(trigger: 'warmup' | 'interval'): Promise<void> {
    if (this.stopped) return;
    if (this.ticking) {
      logger.debug('[threads-reply-scheduler] tick skipped — previous still running');
      return;
    }
    this.ticking = true;
    try {
      await this.attempt(trigger);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        '[threads-reply-scheduler] tick crashed; swallowing',
      );
    } finally {
      this.ticking = false;
    }
  }

  private async attempt(trigger: 'warmup' | 'interval'): Promise<void> {
    const enabled = getRuntimeConfig<boolean>(CFG_ENABLED, true);
    if (!enabled) {
      logger.debug('[threads-reply-scheduler] disabled via runtime_config');
      return;
    }

    // Persistent-throttle gate. Threads has its own independent search
    // cooldown tracked in ~/.ohwow/threads-search-throttle.json; skip
    // the entire tick when it's active so we don't re-hit the rate
    // limit and reset the backoff clock.
    const throttleStatus = threadsThrottleTracker.isThrottled();
    if (throttleStatus.throttled && throttleStatus.until) {
      logger.warn(
        {
          event: 'x_search_deferred',
          platform: 'threads',
          trigger,
          retryAfter: throttleStatus.until.toISOString(),
          remainingMs: throttleStatus.remainingMs,
        },
        '[threads-reply-scheduler] tick deferred — threads search is throttled',
      );
      return;
    }

    const queries = normalizeQueries(getRuntimeConfig<unknown>(CFG_QUERIES, DEFAULT_THREADS_REPLY_QUERIES));
    const approvalRequired = getRuntimeConfig<boolean>(CFG_APPROVAL_REQUIRED, true);
    const topN = getRuntimeConfig<number>(CFG_TOPN, DEFAULT_TOPN) || DEFAULT_TOPN;

    logger.info(
      { trigger, queries: queries.length, topN, approvalRequired },
      '[threads-reply-scheduler] tick entering scan phase',
    );

    const pool = await this.scanPool(queries);
    if (pool.length === 0) {
      logger.info('[threads-reply-scheduler] pool empty; skipping tick');
      return;
    }

    const draftedUrls = await this.loadDraftedUrls();
    const freshPool = pool.filter((t) => !draftedUrls.has(t.candidate.url));
    if (freshPool.length === 0) {
      logger.info('[threads-reply-scheduler] all pool URLs already have drafts');
      return;
    }

    const perQuerySurvivors: Array<{ candidate: ReplyCandidate; score: number; query: ThreadsReplyQuery }> = [];
    for (const q of queries) {
      const qPool = freshPool.filter((t) => t.query.q === q.q).map((t) => t.candidate);
      if (qPool.length === 0) continue;
      const sel = pickReplyTargets({
        candidates: qPool,
        filters: filtersFor(q),
        topicKeywords: [],
        topN: 100,
      });
      for (const s of sel.accepted) {
        perQuerySurvivors.push({ candidate: s.candidate, score: s.score, query: q });
      }
    }
    if (perQuerySurvivors.length === 0) {
      logger.info('[threads-reply-scheduler] no posts survived per-query filters');
      return;
    }

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
      '[threads-reply-scheduler] survivors after cross-author dedup',
    );

    const classifyBudget = Math.min(crossDedup.length, topN * 3);
    const toClassify = crossDedup.slice(0, classifyBudget);
    const verdicts = await classifyReplyTargetsBatch(
      { db: this.db, engine: this.engine, workspaceId: this.workspaceId },
      toClassify.map((s) => s.candidate),
      CLASSIFIER_CONCURRENCY,
    );

    const keepers: Array<{ candidate: ReplyCandidate; score: number; query: ThreadsReplyQuery; verdict: ReplyClassifierVerdict }> = [];
    for (let i = 0; i < toClassify.length; i++) {
      if (isKeeper(verdicts[i])) {
        keepers.push({ ...toClassify[i], verdict: verdicts[i] });
      }
    }
    keepers.sort((a, b) => b.score - a.score);

    logger.info(
      { classified: toClassify.length, keepers: keepers.length },
      '[threads-reply-scheduler] classifier results',
    );
    if (keepers.length === 0) return;

    const toDraft = keepers.slice(0, topN);
    let inserted = 0;
    for (const k of toDraft) {
      const existing = await findReplyDraftByUrl(this.db, this.workspaceId, k.candidate.url);
      if (existing) continue;

      // Enrich with full Threads post text — search snippets are truncated.
      const full = await fetchThreadsPostFullText(k.candidate.url).catch(() => null);
      const enrichedCandidate: ReplyCandidate = full && full.length > (k.candidate.text?.length ?? 0)
        ? { ...k.candidate, text: full }
        : k.candidate;

      // Pick drafter mode from classifier verdict (Threads is direct-only
      // today; viral-piggyback is deferred until Threads exposes a top-sort
      // tab). buyer_intent → ohwow-naming drafter; adjacent_prospect →
      // praise drafter; else the default observational drafter.
      const drafterMode = drafterModeForClass('direct', k.verdict.class);
      const gen = await generateReplyCopy(
        { db: this.db, engine: this.engine, workspaceId: this.workspaceId },
        { target: enrichedCandidate, platform: 'threads', mode: drafterMode },
      );
      if (!gen.ok) {
        logger.warn({ err: gen.error, url: k.candidate.url }, '[threads-reply-scheduler] generator failed');
        continue;
      }
      if (gen.draft === 'SKIP') {
        logger.info(
          { url: k.candidate.url, rationale: gen.rationale },
          '[threads-reply-scheduler] candidate skipped by generator',
        );
        continue;
      }

      // Belt-and-suspenders voice gate: fix cosmetic violations first, then
      // reject any draft that still fails the gate. generateReplyCopy runs
      // voiceCheck internally but this catches drifts introduced by later
      // enrichment or alternate-selection paths before the row lands in DB.
      const fixedDraft = autoFixCosmetic(gen.draft!);
      const gateResult = voiceCheck(fixedDraft, { platform: 'threads', useCase: 'reply' });
      if (!gateResult.ok) {
        logger.warn(
          { url: k.candidate.url, reasons: gateResult.reasons },
          '[threads-reply-scheduler] draft failed voice gate; skipping insert',
        );
        continue;
      }

      const row = await insertReplyDraft(this.db, {
        workspaceId: this.workspaceId,
        platform: 'threads',
        replyToUrl: k.candidate.url,
        replyToAuthor: k.candidate.authorHandle,
        replyToText: enrichedCandidate.text,
        replyToLikes: k.candidate.likes,
        replyToReplies: k.candidate.replies,
        mode: 'direct',
        body: fixedDraft,
        alternates: gen.alternates,
        verdict: k.verdict,
        score: k.score,
        initialStatus: approvalRequired ? 'pending' : 'auto_applied',
      });
      if (row) {
        inserted++;
        logger.info(
          { id: row.id, url: k.candidate.url, score: k.score, approvalRequired },
          '[threads-reply-scheduler] draft inserted',
        );
      }
    }
    logger.info({ inserted, drafted: toDraft.length }, '[threads-reply-scheduler] tick complete');
  }

  // ---- helpers ----

  private async scanPool(queries: ThreadsReplyQuery[]): Promise<TaggedCandidate[]> {
    const pool: TaggedCandidate[] = [];
    const seen = new Set<string>();
    for (const q of queries) {
      try {
        const res = await scanThreadsPostsViaBrowser({
          source: `search:${q.q}`,
          limit: SCAN_LIMIT_PER_QUERY,
          scrollRounds: SCAN_SCROLL_ROUNDS,
        });
        for (const p of res.posts.map(threadToCandidate)) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          pool.push({ candidate: p, query: q });
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err, q: q.q },
          '[threads-reply-scheduler] scan query failed',
        );
      }
    }
    return pool;
  }

  private async loadDraftedUrls(): Promise<Set<string>> {
    try {
      const { data } = await this.db
        .from<{ reply_to_url: string }>('x_reply_drafts')
        .select('reply_to_url')
        .eq('workspace_id', this.workspaceId)
        .eq('platform', 'threads');
      const rows = Array.isArray(data) ? data : [];
      return new Set(rows.map((r) => r.reply_to_url).filter(Boolean));
    } catch {
      return new Set<string>();
    }
  }
}
