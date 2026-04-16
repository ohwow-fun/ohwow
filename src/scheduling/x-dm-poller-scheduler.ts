/**
 * XDmPollerScheduler — first-cut ingest of X DMs into runtime DB.
 *
 * Calls listDmsViaBrowser on a fixed cadence (default hourly), upserts
 * one row per conversation_pair into x_dm_threads, appends a new
 * observation to x_dm_observations only when the preview text changed
 * (sha1 dedup), and mirrors the same delta to a daily JSONL ledger
 * under the workspace dir. That's it for this commit — no findings
 * emission, no contact linking, no auto-replies. Those layer on
 * after a clean ingest is observed.
 *
 * Lane contention with ContentCadenceScheduler
 * --------------------------------------------
 * Both schedulers drive the same debug Chrome via raw CDP. Today the
 * contention guard is per-instance (`executing` boolean prevents
 * overlapping ticks within THIS scheduler) — there's no cross-
 * scheduler lock. Risk is small because list_dms navigates
 * https://x.com/i/chat (a different tab from /compose/post) and reads
 * with no clicks, so it shouldn't disturb a posting tick. If we ever
 * see DM-tick interleaving cause a posting failure, the right fix is
 * a workspace-level CDP lane lock in chrome-profile-router; documenting
 * here so the next person sees the trade-off.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';
import {
  listDmsViaBrowser,
  type DmThreadSummary,
  type ListDmsInput,
  type ListDmsResult,
} from '../orchestrator/tools/x-posting.js';

/** Default tick interval — every hour. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
/** How many threads to ask for per tick. */
const FETCH_LIMIT = 50;

export interface XDmPollerSchedulerOptions {
  /**
   * Absolute path to the workspace data dir. Daily JSONL files are
   * written under this dir as `x-dms-YYYY-MM-DD.jsonl`. Optional —
   * when unset, only DB writes happen (used in tests).
   */
  dataDir?: string;
  /**
   * Override the inbox lister. Tests inject a fake; prod uses the
   * real CDP-driven listDmsViaBrowser.
   */
  inboxLister?: (input: ListDmsInput) => Promise<ListDmsResult>;
}

/** Subset of x_dm_threads relevant to upsert decisions. */
interface ExistingThreadRow {
  id: string;
  last_preview_hash: string | null;
  observation_count: number | null;
}

export class XDmPollerScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private executing = false;
  private readonly inboxLister: (input: ListDmsInput) => Promise<ListDmsResult>;
  private readonly dataDir: string | null;

  constructor(
    private db: DatabaseAdapter,
    private workspaceId: string,
    options: XDmPollerSchedulerOptions = {},
  ) {
    this.inboxLister = options.inboxLister ?? listDmsViaBrowser;
    this.dataDir = options.dataDir ?? null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    logger.info({ intervalMs }, '[XDmPollerScheduler] started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info('[XDmPollerScheduler] stopped');
  }

  /**
   * Single ingest tick. Public for integration tests.
   *
   * Failure policy: a list_dms failure logs and returns — we never
   * propagate. DMs aren't time-critical, and a wedged Chrome session
   * during a posting tick must not also crash the poller.
   */
  async tick(): Promise<void> {
    if (this.executing) return;
    this.executing = true;
    const startedAt = Date.now();
    try {
      const result = await this.inboxLister({ limit: FETCH_LIMIT });
      if (!result.success || !result.threads) {
        logger.warn(
          { message: result.message },
          '[XDmPollerScheduler] inbox fetch failed',
        );
        return;
      }
      let inserted = 0;
      let unchanged = 0;
      for (const thread of result.threads) {
        const wrote = await this.ingestThread(thread);
        if (wrote) inserted++;
        else unchanged++;
      }
      logger.info(
        {
          threads: result.threads.length,
          inserted,
          unchanged,
          ms: Date.now() - startedAt,
        },
        '[XDmPollerScheduler] tick complete',
      );
    } catch (err) {
      logger.error({ err }, '[XDmPollerScheduler] tick failed');
    } finally {
      this.executing = false;
    }
  }

  /**
   * Upsert one thread row + (only if preview changed) one observation.
   * Returns true when a new observation was written.
   */
  private async ingestThread(thread: DmThreadSummary): Promise<boolean> {
    const previewHash = sha1(thread.preview);
    const nowIso = new Date().toISOString();

    const existing = await this.findThread(thread.pair);
    const isNew = !existing;
    const previewChanged = isNew || existing.last_preview_hash !== previewHash;

    if (isNew) {
      try {
        await this.db.from('x_dm_threads').insert({
          workspace_id: this.workspaceId,
          conversation_pair: thread.pair,
          primary_name: thread.primaryName,
          last_preview: thread.preview,
          last_preview_hash: previewHash,
          has_unread: thread.hasUnread ? 1 : 0,
          observation_count: 1,
          first_seen_at: nowIso,
          last_seen_at: nowIso,
          raw_meta: JSON.stringify({ ingested_at: nowIso }),
        });
      } catch (err) {
        // Race: another tick may have inserted between findThread and
        // here. Tolerate by treating as an existing-thread update.
        logger.debug(
          { err: err instanceof Error ? err.message : err, pair: thread.pair },
          '[XDmPollerScheduler] thread insert failed; treating as existing',
        );
      }
    } else if (previewChanged) {
      await this.db
        .from('x_dm_threads')
        .update({
          primary_name: thread.primaryName,
          last_preview: thread.preview,
          last_preview_hash: previewHash,
          has_unread: thread.hasUnread ? 1 : 0,
          observation_count: (existing.observation_count ?? 0) + 1,
          last_seen_at: nowIso,
        })
        .eq('id', existing.id);
    } else {
      // Preview unchanged: still bump last_seen_at + has_unread (the
      // unread flag can flip without the message text changing).
      await this.db
        .from('x_dm_threads')
        .update({
          has_unread: thread.hasUnread ? 1 : 0,
          last_seen_at: nowIso,
        })
        .eq('id', existing.id);
    }

    if (!previewChanged) return false;

    // UNIQUE(workspace_id, conversation_pair, preview_hash) protects
    // against duplicate observations across racy ticks. We catch the
    // exception so the rest of the tick continues.
    try {
      await this.db.from('x_dm_observations').insert({
        workspace_id: this.workspaceId,
        conversation_pair: thread.pair,
        primary_name: thread.primaryName,
        preview_text: thread.preview,
        preview_hash: previewHash,
        has_unread: thread.hasUnread ? 1 : 0,
        observed_at: nowIso,
      });
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : err, pair: thread.pair },
        '[XDmPollerScheduler] observation insert lost dedup race',
      );
      return false;
    }

    this.appendJsonl({
      ts: nowIso,
      pair: thread.pair,
      primary_name: thread.primaryName,
      preview: thread.preview,
      preview_hash: previewHash,
      has_unread: thread.hasUnread,
      first_seen: isNew,
    });
    return true;
  }

  private async findThread(pair: string): Promise<ExistingThreadRow | null> {
    try {
      const { data } = await this.db
        .from<ExistingThreadRow>('x_dm_threads')
        .select('id, last_preview_hash, observation_count')
        .eq('workspace_id', this.workspaceId)
        .eq('conversation_pair', pair)
        .maybeSingle();
      return (data as ExistingThreadRow | null) ?? null;
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : err, pair },
        '[XDmPollerScheduler] findThread failed; assuming new',
      );
      return null;
    }
  }

  private appendJsonl(entry: Record<string, unknown>): void {
    if (!this.dataDir) return;
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(this.dataDir, `x-dms-${day}.jsonl`);
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, file },
        '[XDmPollerScheduler] JSONL append failed',
      );
    }
  }
}

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}
