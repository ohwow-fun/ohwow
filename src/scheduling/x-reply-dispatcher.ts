/**
 * ReplyDispatcher — consumes approved x_reply_drafts rows and publishes
 * them via the appropriate posting executor. One class parameterized by
 * platform so X and Threads share the flow:
 *
 *   - X:       xPostingExecutor.execute('x_compose_reply', …)
 *   - Threads: threadsPostingExecutor.execute('threads_compose_reply', …)
 *
 * Per tick:
 *   1. Enforce daily cap (runtime_config `x_reply.daily_cap` / 10 default)
 *      against posted_log rows with source='reply_to:*' today.
 *   2. Fetch the oldest approved drafts for the platform.
 *   3. For each up to MAX_SENDS_PER_TICK:
 *        a. Take the CDP lane.
 *        b. Call the posting executor (dry_run=false).
 *        c. On success: mark the draft 'applied'.
 *        d. On failure: leave 'approved' for natural retry next tick.
 *   4. Log a single summary line.
 *
 * auto_applied rows are treated identically to 'approved' — they come
 * from the approval-gate-disabled path (scheduler writes straight to
 * approved-equivalent status when `x_reply.approval_required=false`).
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { withCdpLane } from '../execution/browser/cdp-lane.js';
import { logger } from '../lib/logger.js';
import { getRuntimeConfig } from '../self-bench/runtime-config.js';
import { xPostingExecutor } from '../execution/tool-dispatch/x-posting-executor.js';
import { threadsPostingExecutor } from '../execution/tool-dispatch/threads-posting-executor.js';
import type { ToolExecutor, ToolExecutionContext } from '../execution/tool-dispatch/types.js';
import {
  listApprovedForDispatch,
  setReplyDraftStatus,
  type ReplyDraftPlatform,
  type ReplyDraftRow,
} from './x-reply-store.js';

const DEFAULT_TICK_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_WARMUP_MS = 90 * 1000;   // 1.5 min after daemon boot
const MAX_SENDS_PER_TICK = 1;          // one reply per tick, matches legacy cadence

const POSTING_EXECUTORS: Record<ReplyDraftPlatform, {
  executor: ToolExecutor;
  toolName: string;
  cfgDailyCap: string;
  cfgMinGapSeconds: string;
}> = {
  x: {
    executor: xPostingExecutor,
    toolName: 'x_compose_reply',
    cfgDailyCap: 'x_reply.daily_cap',
    cfgMinGapSeconds: 'x_reply.min_gap_seconds',
  },
  threads: {
    executor: threadsPostingExecutor,
    toolName: 'threads_compose_reply',
    cfgDailyCap: 'threads_reply.daily_cap',
    cfgMinGapSeconds: 'threads_reply.min_gap_seconds',
  },
};

const DEFAULT_DAILY_CAP = 10;
// Minimum time between successful replies on a platform. A scheduler
// tick may find several approved drafts lined up; without this gate,
// the dispatcher fires them back-to-back over a handful of minutes,
// which both reads as bot cadence to human viewers and gets us rate-
// flagged. The platform-specific runtime_config key overrides this.
const DEFAULT_MIN_GAP_SECONDS = 20 * 60;

export interface ReplyDispatcherOpts {
  db: DatabaseAdapter;
  workspaceId: string;
  workspaceSlug: string;
  platform: ReplyDraftPlatform;
  tickIntervalMs?: number;
  warmupMs?: number;
}

export class ReplyDispatcher {
  private readonly db: DatabaseAdapter;
  private readonly workspaceId: string;
  private readonly workspaceSlug: string;
  private readonly platform: ReplyDraftPlatform;
  private readonly tickIntervalMs: number;
  private readonly warmupMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private warmupTimer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private stopped = false;

  constructor(opts: ReplyDispatcherOpts) {
    this.db = opts.db;
    this.workspaceId = opts.workspaceId;
    this.workspaceSlug = opts.workspaceSlug;
    this.platform = opts.platform;
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.warmupMs = opts.warmupMs ?? DEFAULT_WARMUP_MS;
  }

  private label(): string {
    return `[${this.platform}-reply-dispatcher]`;
  }

  start(): void {
    if (this.timer) return;
    logger.info(
      { tickIntervalMs: this.tickIntervalMs, warmupMs: this.warmupMs, workspace: this.workspaceSlug, platform: this.platform },
      `${this.label()} starting`,
    );
    this.warmupTimer = setTimeout(() => { void this.tick(); }, this.warmupMs);
    this.timer = setInterval(() => { void this.tick(); }, this.tickIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.warmupTimer) { clearTimeout(this.warmupTimer); this.warmupTimer = null; }
    logger.info(`${this.label()} stopped`);
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.ticking) {
      logger.debug(`${this.label()} tick skipped — previous still running`);
      return;
    }
    this.ticking = true;
    try {
      await this.attempt();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        `${this.label()} tick crashed; swallowing`,
      );
    } finally {
      this.ticking = false;
    }
  }

  private async attempt(): Promise<void> {
    const { executor, toolName, cfgDailyCap, cfgMinGapSeconds } = POSTING_EXECUTORS[this.platform];

    // Daily cap — previously enforced in the scheduler; moved here because
    // this is the side that actually posts. We count posted_log rows for
    // today and bail if we've already hit the cap.
    const dailyCap = getRuntimeConfig<number>(cfgDailyCap, DEFAULT_DAILY_CAP) || DEFAULT_DAILY_CAP;
    const todayCount = await this.countRepliesToday();
    if (todayCount >= dailyCap) {
      logger.info({ todayCount, dailyCap }, `${this.label()} daily cap reached; skipping`);
      return;
    }

    // Per-platform minimum gap between dispatches. The scheduler queues
    // up drafts in bursts, and without this the dispatcher fires the
    // first N approved rows back-to-back every tick — which looked
    // exactly like the bot cadence we're trying to stop. A 20-minute
    // default spreads replies across the active window and is
    // override-able via <platform>_reply.min_gap_seconds at runtime.
    const minGapSecondsRaw = getRuntimeConfig<number>(cfgMinGapSeconds, DEFAULT_MIN_GAP_SECONDS);
    const minGapSeconds = Number.isFinite(minGapSecondsRaw) && minGapSecondsRaw >= 0
      ? minGapSecondsRaw
      : DEFAULT_MIN_GAP_SECONDS;
    if (minGapSeconds > 0) {
      const lastAppliedAt = await this.lastAppliedAt();
      if (lastAppliedAt) {
        const sinceSeconds = (Date.now() - lastAppliedAt.getTime()) / 1000;
        if (sinceSeconds < minGapSeconds) {
          logger.debug(
            { sinceSeconds: Math.round(sinceSeconds), minGapSeconds },
            `${this.label()} within min-gap window; skipping`,
          );
          return;
        }
      }
    }

    const drafts = await listApprovedForDispatch(
      this.db,
      this.workspaceId,
      this.platform,
      MAX_SENDS_PER_TICK,
    );
    if (drafts.length === 0) {
      const pendingCount = await this.countPending();
      logger.debug(
        { platform: this.platform, pendingCount, dailyCap, todayCount },
        `${this.label()} no dispatch-ready drafts; nothing to post this tick`,
      );
      return;
    }

    // Pre-dispatch jitter: wait 0–3 min so posts don't land exactly on
    // tick boundaries (every 5 min on the dot is a bot timing signature).
    const preJitterMs = Math.floor(Math.random() * 3 * 60 * 1000);
    if (preJitterMs > 0) {
      logger.debug({ preJitterMs }, `${this.label()} pre-dispatch jitter`);
      await new Promise<void>((resolve) => setTimeout(resolve, preJitterMs));
      if (this.stopped) return;
    }

    let sent = 0;
    let failed = 0;
    for (const draft of drafts) {
      const ok = await this.dispatchOne(draft, executor, toolName);
      if (ok) sent++;
      else failed++;
      if (sent >= MAX_SENDS_PER_TICK) break;
    }
    logger.info(
      { attempted: drafts.length, sent, failed, dailyCap, todayCount },
      `${this.label()} tick complete`,
    );
  }

  private async dispatchOne(
    draft: ReplyDraftRow,
    executor: ToolExecutor,
    toolName: string,
  ): Promise<boolean> {
    if (!draft.body || draft.body.trim().length === 0) {
      logger.warn({ id: draft.id }, `${this.label()} draft body empty; marking rejected to avoid retry`);
      await setReplyDraftStatus(this.db, this.workspaceId, draft.id, 'rejected');
      return false;
    }
    if (!draft.reply_to_url) {
      logger.warn({ id: draft.id }, `${this.label()} draft missing reply_to_url; marking rejected`);
      await setReplyDraftStatus(this.db, this.workspaceId, draft.id, 'rejected');
      return false;
    }

    const ctx = { db: this.db, workspaceId: this.workspaceId } as unknown as ToolExecutionContext;
    const input = {
      reply_to_url: draft.reply_to_url,
      text: draft.body,
      dry_run: false,
    };

    let result;
    try {
      result = await withCdpLane(
        this.workspaceId,
        () => executor.execute(toolName, input, ctx),
        { label: `${this.platform}-reply-dispatcher:send` },
      );
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err, id: draft.id, url: draft.reply_to_url },
        `${this.label()} send threw; leaving approved for retry`,
      );
      return false;
    }

    const parsed = this.safeParse(String(result.content));
    if (result.is_error || !parsed?.success) {
      logger.warn(
        { id: draft.id, url: draft.reply_to_url, message: parsed?.message },
        `${this.label()} publish failed; leaving approved for retry`,
      );
      return false;
    }

    const status = draft.status === 'auto_applied' ? 'auto_applied' : 'applied';
    await setReplyDraftStatus(this.db, this.workspaceId, draft.id, status);
    logger.info(
      { id: draft.id, url: draft.reply_to_url, chars: draft.body.length, mode: draft.mode },
      `${this.label()} reply published`,
    );
    return true;
  }

  private async countPending(): Promise<number> {
    try {
      const { data } = await this.db
        .from<{ id: string }>('x_reply_drafts')
        .select('id')
        .eq('workspace_id', this.workspaceId)
        .eq('platform', this.platform)
        .eq('status', 'pending');
      return Array.isArray(data) ? data.length : 0;
    } catch {
      return 0;
    }
  }

  private async lastAppliedAt(): Promise<Date | null> {
    try {
      const { data } = await this.db
        .from<{ applied_at: string | null }>('x_reply_drafts')
        .select('applied_at')
        .eq('workspace_id', this.workspaceId)
        .eq('platform', this.platform)
        .order('applied_at', { ascending: false })
        .limit(5);
      const rows = Array.isArray(data) ? data : [];
      for (const r of rows) {
        if (r.applied_at) {
          const d = new Date(r.applied_at);
          if (!Number.isNaN(d.getTime())) return d;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private async countRepliesToday(): Promise<number> {
    try {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const { data } = await this.db
        .from<{ source: string; posted_at: string }>('posted_log')
        .select('source,posted_at')
        .eq('platform', this.platform)
        .gte('posted_at', startOfDay.toISOString());
      const rows = Array.isArray(data) ? data : [];
      return rows.filter((r) => r.source?.startsWith('reply_to:')).length;
    } catch {
      return 0;
    }
  }

  private safeParse(s: string): { success?: boolean; message?: string } | null {
    try { return JSON.parse(s); } catch { return null; }
  }
}
