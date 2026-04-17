/**
 * XReplyScheduler — 10-minute autonomous X reply loop.
 *
 * Direct mirror of ThreadsReplyScheduler. Pipeline per tick (default
 * every 10 min):
 *   1. Check enablement: runtime_config key `x_reply.enabled`.
 *      Defaults to true on the `default` workspace.
 *   2. Check daily cap: count posted_log rows where platform='x' AND
 *      source LIKE 'reply_to:%' AND posted_at >= start-of-today. If
 *      >= cap, skip this tick.
 *   3. Check cooldown: last such row's posted_at must be >=
 *      min_cooldown_seconds ago. If not, skip.
 *   4. Scan: N X topic searches (default claude code, AI agents, LLM
 *      memory) via scanXPostsViaBrowser with the live tab.
 *   5. Filter + rank via pickReplyTargets (deterministic selector,
 *      requireTopicMatch=true for noisy search feeds).
 *   6. Walk top-N in score order: generate a draft via the calibrated
 *      voice for platform='x'. First non-SKIP wins.
 *   7. Publish via x_compose_reply — the executor auto-dedups against
 *      posted_log and auto-logs after success.
 *
 * Why no fetch-full-text enrichment step (which the Threads variant
 * does): X tweets are already short enough that search snippets
 * return the whole text. Threads posts can be 500+ chars and get
 * truncated in search, which is why the Threads loop navigates to
 * each permalink to enrich. If X tweets ever start returning truncated
 * bodies we add the hop then.
 *
 * Reentrancy: single in-flight guard. A slow tick never stacks.
 *
 * Failure mode: any exception in a single tick is logged + swallowed;
 * scheduler keeps going. Never takes down the daemon.
 *
 * CDP lane serialization: shares the Chrome profile lane with
 * ContentCadenceScheduler + XDmPollerScheduler + XDmReplyDispatcher.
 * The `ticking` guard prevents self-overlap; cross-scheduler lane
 * contention is handled by the executor's CDP queue — at 10-min
 * cadence with a ~30s typical tick, lane pressure is minimal.
 *
 * Workspace guard: designed for the `default` workspace. Other
 * workspaces should wire their own if they want this behavior.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';
import { logger } from '../lib/logger.js';
import { parseSqliteTimestamp } from '../lib/sqlite-time.js';
import { getRuntimeConfig } from '../self-bench/runtime-config.js';
import { scanXPostsViaBrowser } from '../orchestrator/tools/x-reply.js';
import { pickReplyTargets, tweetToCandidate } from '../orchestrator/tools/reply-target-selector.js';
import { generateReplyCopy } from '../orchestrator/tools/reply-copy-generator.js';
import { xPostingExecutor } from '../execution/tool-dispatch/x-posting-executor.js';

// ---------------------------------------------------------------------------
// Runtime config keys (all optional; sane defaults below)
// ---------------------------------------------------------------------------

const CFG_ENABLED = 'x_reply.enabled';
const CFG_DAILY_CAP = 'x_reply.daily_cap';
const CFG_MIN_COOLDOWN_S = 'x_reply.min_cooldown_seconds';
const CFG_QUERIES = 'x_reply.queries';
const CFG_TOPN = 'x_reply.topn';

const DEFAULT_TICK_MS = 10 * 60 * 1000; // 10 minutes
// Warmup is staggered from ThreadsReplyScheduler's 2-min warmup so the
// two don't race for the same CDP lane on boot. Threads fires first,
// X follows 90s later.
const DEFAULT_WARMUP_MS = 3.5 * 60 * 1000;
const DEFAULT_QUERIES = ['claude code', 'AI agents', 'LLM memory'];
const DEFAULT_DAILY_CAP = 10;
const DEFAULT_MIN_COOLDOWN_S = 8 * 60; // 8 minutes between replies
const DEFAULT_TOPN = 5;
const SCAN_LIMIT_PER_QUERY = 15;
const SCAN_SCROLL_ROUNDS = 3;

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export interface XReplySchedulerOpts {
  db: DatabaseAdapter;
  engine: RuntimeEngine;
  workspaceId: string;
  workspaceSlug: string;
  /** Override default 10-minute cadence (tests + fast-mode). */
  tickIntervalMs?: number;
  /** Override warm-up delay before first tick. */
  warmupMs?: number;
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

  // ---- tick ----

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
    // 1. Enablement gate
    const enabled = getRuntimeConfig<boolean>(CFG_ENABLED, true);
    if (!enabled) {
      logger.debug('[x-reply-scheduler] disabled via runtime_config');
      return;
    }

    // 2. Daily cap
    const dailyCap = getRuntimeConfig<number>(CFG_DAILY_CAP, DEFAULT_DAILY_CAP) || DEFAULT_DAILY_CAP;
    const todayCount = await this.countRepliesToday();
    if (todayCount >= dailyCap) {
      logger.info({ todayCount, dailyCap }, '[x-reply-scheduler] daily cap reached; skipping');
      return;
    }

    // 3. Cooldown since last reply
    const minCooldownSec = getRuntimeConfig<number>(CFG_MIN_COOLDOWN_S, DEFAULT_MIN_COOLDOWN_S) || DEFAULT_MIN_COOLDOWN_S;
    const sinceLastSec = await this.secondsSinceLastReply();
    if (sinceLastSec !== null && sinceLastSec < minCooldownSec) {
      logger.debug(
        { sinceLastSec, minCooldownSec },
        '[x-reply-scheduler] cooldown active; skipping',
      );
      return;
    }

    logger.info(
      { trigger, todayCount, dailyCap, sinceLastSec },
      '[x-reply-scheduler] tick entering scan phase',
    );

    // 4. Scan
    const queries = getRuntimeConfig<string[]>(CFG_QUERIES, DEFAULT_QUERIES) || DEFAULT_QUERIES;
    const pool = await this.scanPool(queries);
    if (pool.length === 0) {
      logger.info('[x-reply-scheduler] pool empty; skipping tick');
      return;
    }

    // 5. Filter + rank. Exclude posts we've already replied to via posted_log.
    const repliedUrls = await this.loadRepliedUrls();
    const freshPool = pool.filter((c) => !repliedUrls.has(c.url));

    const topN = getRuntimeConfig<number>(CFG_TOPN, DEFAULT_TOPN) || DEFAULT_TOPN;
    const sel = pickReplyTargets({
      candidates: freshPool,
      filters: {
        // Exclude our own posting handles — mirror of Threads scheduler
        // defaults. If the X identity is different from Threads, this
        // over-excludes on the Threads handle but that's harmless (the
        // Threads handle won't appear in X search results anyway).
        excludeHandles: ['ohwow_fun', 'aidreammm'],
        requireTopicMatch: true,
        maxAgeHours: 336,
        maxLikes: 500,
        maxReplies: 40,
        minTextLength: 20,
      },
      topN,
    });
    logger.info(
      { poolSize: freshPool.length, accepted: sel.accepted.length, topN: sel.topN.length },
      '[x-reply-scheduler] selector results',
    );
    if (sel.topN.length === 0) return;

    // 6. Walk top-N, generate first non-SKIP draft.
    for (const pick of sel.topN) {
      const { candidate, score } = pick;

      const gen = await generateReplyCopy(
        { db: this.db, engine: this.engine, workspaceId: this.workspaceId },
        { target: candidate, platform: 'x' },
      );
      if (!gen.ok) {
        logger.warn({ err: gen.error, url: candidate.url }, '[x-reply-scheduler] generator failed');
        continue;
      }
      if (gen.draft === 'SKIP') {
        logger.info(
          { url: candidate.url, rationale: gen.rationale },
          '[x-reply-scheduler] candidate skipped by generator',
        );
        continue;
      }

      // 7. Publish — the executor path writes posted_log on success
      //    and dedups against the log before attempting.
      const result = await xPostingExecutor.execute(
        'x_compose_reply',
        {
          reply_to_url: candidate.url,
          text: gen.draft!,
          dry_run: false,
        },
        { db: this.db, workspaceId: this.workspaceId } as never,
      );
      const parsed = this.safeParse(String(result.content));
      if (result.is_error || !parsed?.success) {
        logger.warn(
          { url: candidate.url, message: parsed?.message },
          '[x-reply-scheduler] publish failed; trying next candidate',
        );
        continue;
      }
      logger.info(
        { url: candidate.url, score, chars: gen.draft!.length, model: gen.modelUsed },
        '[x-reply-scheduler] reply published',
      );
      return; // one reply per tick, done
    }

    logger.info('[x-reply-scheduler] tick completed with no publish (all skipped or failed)');
  }

  // ---- helpers ----

  private async scanPool(queries: string[]) {
    const pool = [] as ReturnType<typeof tweetToCandidate>[];
    const seen = new Set<string>();
    for (const q of queries) {
      try {
        const res = await scanXPostsViaBrowser({
          source: `search:${q}`,
          limit: SCAN_LIMIT_PER_QUERY,
          scrollRounds: SCAN_SCROLL_ROUNDS,
        });
        if (!res.success) {
          logger.warn({ q, message: res.message }, '[x-reply-scheduler] scan returned failure');
          continue;
        }
        for (const t of res.tweets.map(tweetToCandidate)) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          pool.push(t);
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err, q },
          '[x-reply-scheduler] scan query failed',
        );
      }
    }
    return pool;
  }

  private async loadRepliedUrls(): Promise<Set<string>> {
    try {
      const { data } = await this.db
        .from<{ source: string }>('posted_log')
        .select('source')
        .eq('platform', 'x');
      const rows = Array.isArray(data) ? data : [];
      const urls = new Set<string>();
      for (const r of rows) {
        if (r.source?.startsWith('reply_to:')) urls.add(r.source.slice('reply_to:'.length));
      }
      return urls;
    } catch {
      return new Set<string>();
    }
  }

  private async countRepliesToday(): Promise<number> {
    try {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const { data } = await this.db
        .from<{ source: string; posted_at: string }>('posted_log')
        .select('source,posted_at')
        .eq('platform', 'x')
        .gte('posted_at', startOfDay.toISOString());
      const rows = Array.isArray(data) ? data : [];
      // Filter reply_to:* in JS — adapter has no LIKE.
      return rows.filter((r) => r.source?.startsWith('reply_to:')).length;
    } catch {
      return 0;
    }
  }

  private async secondsSinceLastReply(): Promise<number | null> {
    try {
      const { data } = await this.db
        .from<{ source: string; posted_at: string }>('posted_log')
        .select('source,posted_at')
        .eq('platform', 'x')
        .order('posted_at', { ascending: false })
        .limit(50);
      const rows = Array.isArray(data) ? data : [];
      const latest = rows.find((r) => r.source?.startsWith('reply_to:'));
      if (!latest) return null;
      // parseSqliteTimestamp normalizes SQLite's no-TZ string to UTC.
      // Raw Date.parse would treat it as local, flip the sign, and
      // lock the cooldown indefinitely (observed 2026-04-17 at
      // sinceLastSec=-15269).
      const last = parseSqliteTimestamp(latest.posted_at);
      if (isNaN(last)) return null;
      return Math.floor((Date.now() - last) / 1000);
    } catch {
      return null;
    }
  }

  private safeParse(s: string): { success?: boolean; message?: string } | null {
    try { return JSON.parse(s); } catch { return null; }
  }
}
