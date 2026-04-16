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
 * Both schedulers drive the same debug Chrome via raw CDP. The
 * per-instance `executing` boolean only prevents overlap within THIS
 * scheduler; cross-scheduler coordination is provided by the
 * workspace-level CDP lane lock (`withCdpLane`). We take the lane
 * around each individual inbox fetch and per-thread body read — NOT
 * the whole tick — so content-cadence posts can interleave between
 * threads rather than waiting up to ~2min for the full tick to drain.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { withCdpLane } from '../execution/browser/cdp-lane.js';
import { findContactByXUserId, upsertContactFromDm, type ContactRow } from '../lib/contacts.js';
import { logger } from '../lib/logger.js';
import {
  listDmsViaBrowser,
  readDmThreadViaBrowser,
  type DmMessage,
  type DmThreadSummary,
  type ListDmsInput,
  type ListDmsResult,
  type ReadDmThreadInput,
  type ReadDmThreadResult,
} from '../orchestrator/tools/x-posting.js';
import { getRuntimeConfig } from '../self-bench/runtime-config.js';
import { detectTriggerPhrase } from './x-dm-triggers.js';

/**
 * Runtime config key for the operator's own numeric X user id. Set via
 * setRuntimeConfig('x.self_user_id', '1877225919862951937'). When
 * unset, correspondent extraction is skipped and contact linking
 * degrades to a no-op (threads still ingest; no contact_id stamped,
 * no unknown_correspondent signals emitted).
 */
export const X_SELF_USER_ID_CONFIG_KEY = 'x.self_user_id';

/**
 * Split a conversation_pair ('<id1>:<id2>' or '<id1>-<id2>') and return
 * the half that isn't the caller's own id. Null when the pair is
 * malformed OR the selfId does not appear in it (the latter means the
 * operator's configured id doesn't match what X is using — we'd rather
 * skip linking than guess wrong).
 */
export function pickCounterpartyId(pair: string, selfId: string): string | null {
  if (!pair || !selfId) return null;
  const parts = pair.split(/[:\-]/).filter((p) => p.length > 0);
  if (parts.length !== 2) return null;
  if (parts[0] === selfId) return parts[1];
  if (parts[1] === selfId) return parts[0];
  return null;
}

/** Default tick interval — every hour. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
/** How many threads to ask for per tick. */
const FETCH_LIMIT = 50;
/**
 * Cap on how many threads we'll enter per tick. Each thread read costs
 * a navigation + ~3.5s hydration wait, so reading every thread on a
 * busy inbox would burn the whole tick. We only enter threads that
 * looked changed (preview hash differs OR has_unread set), and even
 * then we cap to bound CDP-lane competition with ContentCadence's
 * posting tab. Bumpable when we observe inbox sizes.
 */
const MAX_THREADS_READ_PER_TICK = 8;
/** Cap on messages pulled per thread (newest-last). */
const THREAD_READ_LIMIT = 30;

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
  /**
   * Override the thread reader. Tests inject a fake; prod uses the
   * real CDP-driven readDmThreadViaBrowser.
   */
  threadReader?: (input: ReadDmThreadInput) => Promise<ReadDmThreadResult>;
}

/** Subset of x_dm_threads relevant to upsert decisions. */
interface ExistingThreadRow {
  id: string;
  last_preview_hash: string | null;
  observation_count: number | null;
}

interface ExistingUnlinkedThread {
  id: string;
  conversation_pair: string;
  primary_name: string | null;
  counterparty_user_id: string | null;
}

/** Cached identity resolution for a thread during one tick. */
interface CounterpartyResolution {
  counterpartyUserId: string | null;
  contactId: string | null;
}

export class XDmPollerScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private executing = false;
  private readonly inboxLister: (input: ListDmsInput) => Promise<ListDmsResult>;
  private readonly threadReader: (input: ReadDmThreadInput) => Promise<ReadDmThreadResult>;
  private readonly dataDir: string | null;

  constructor(
    private db: DatabaseAdapter,
    private workspaceId: string,
    options: XDmPollerSchedulerOptions = {},
  ) {
    this.inboxLister = options.inboxLister ?? listDmsViaBrowser;
    this.threadReader = options.threadReader ?? readDmThreadViaBrowser;
    this.dataDir = options.dataDir ?? null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.running) return;
    this.running = true;
    void this.backfillUnlinkedContacts();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    logger.info({ intervalMs }, '[XDmPollerScheduler] started');
  }

  /**
   * One-shot backfill on boot: any x_dm_threads row without a contact_id
   * gets a fresh contact created from its cached primary_name +
   * conversation_pair. Runs off the browser path so it works even when
   * Chrome is unavailable. Idempotent — upsertContactFromDm keys on
   * conversation_pair, so re-running is a no-op once threads are
   * linked.
   */
  private async backfillUnlinkedContacts(): Promise<void> {
    try {
      const { data } = await this.db
        .from<ExistingUnlinkedThread>('x_dm_threads')
        .select('id, conversation_pair, primary_name, counterparty_user_id')
        .eq('workspace_id', this.workspaceId)
        .is('contact_id', null)
        .limit(200);
      const rows = (data as ExistingUnlinkedThread[] | null) ?? [];
      if (rows.length === 0) return;
      let linked = 0;
      for (const row of rows) {
        const contactId = await upsertContactFromDm(this.db, this.workspaceId, {
          conversationPair: row.conversation_pair,
          primaryName: row.primary_name,
          counterpartyUserId: row.counterparty_user_id,
        });
        if (!contactId) continue;
        try {
          await this.db
            .from('x_dm_threads')
            .update({ contact_id: contactId })
            .eq('id', row.id);
          linked++;
        } catch { /* next tick tries again */ }
      }
      if (linked > 0) {
        logger.info({ linked, scanned: rows.length }, '[XDmPollerScheduler] backfilled DM contact links');
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, '[XDmPollerScheduler] backfill failed');
    }
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
      const result = await withCdpLane(
        this.workspaceId,
        () => this.inboxLister({ limit: FETCH_LIMIT }),
        { label: 'x-dm-poller:inbox' },
      );
      if (!result.success || !result.threads) {
        logger.warn(
          { message: result.message },
          '[XDmPollerScheduler] inbox fetch failed',
        );
        return;
      }
      // Resolve once per tick: the configured self user id is cached
      // in runtime-config, so this is a synchronous cache read. When
      // unset, correspondent extraction is skipped for the whole tick.
      const selfUserId = getRuntimeConfig<string | null>(X_SELF_USER_ID_CONFIG_KEY, null);

      // Phase 1: ingest inbox-level summaries (cheap, no per-thread nav).
      // Track which threads look interesting enough to enter for body
      // reads — preview changed since last tick OR thread is unread.
      const candidates: DmThreadSummary[] = [];
      // Cache the per-thread counterparty resolution so ingestThreadBodies
      // doesn't repeat the contact lookup a second time.
      const resolutionByPair = new Map<string, CounterpartyResolution>();
      let inserted = 0;
      let unchanged = 0;
      for (const thread of result.threads) {
        const resolution = await this.resolveCounterparty(thread.pair, selfUserId, thread.primaryName);
        resolutionByPair.set(thread.pair, resolution);
        const { previewChanged } = await this.ingestThread(thread, resolution);
        if (previewChanged) inserted++;
        else unchanged++;
        if (previewChanged || thread.hasUnread) candidates.push(thread);
      }

      // Phase 2: enter changed/unread threads to capture message bodies.
      // Cap to MAX_THREADS_READ_PER_TICK to bound CDP-lane time. Newest
      // candidates first — they're the ones most likely to need the
      // operator's attention.
      const toRead = candidates.slice(0, MAX_THREADS_READ_PER_TICK);
      let messagesIngested = 0;
      let threadsRead = 0;
      let threadsFailed = 0;
      for (const thread of toRead) {
        const resolution = resolutionByPair.get(thread.pair)
          ?? { counterpartyUserId: null, contactId: null };
        const newMsgs = await this.ingestThreadBodies(thread, resolution);
        if (newMsgs === null) threadsFailed++;
        else { threadsRead++; messagesIngested += newMsgs; }
      }

      logger.info(
        {
          threads: result.threads.length,
          inserted,
          unchanged,
          threadsRead,
          threadsFailed,
          messagesIngested,
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
   * Returns whether the preview changed so the caller can decide to
   * enter the thread for a body read.
   */
  private async ingestThread(
    thread: DmThreadSummary,
    resolution: CounterpartyResolution,
  ): Promise<{ previewChanged: boolean }> {
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
          counterparty_user_id: resolution.counterpartyUserId,
          contact_id: resolution.contactId,
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
          counterparty_user_id: resolution.counterpartyUserId,
          contact_id: resolution.contactId,
        })
        .eq('id', existing.id);
    } else {
      // Preview unchanged: still bump last_seen_at + has_unread (the
      // unread flag can flip without the message text changing), and
      // refresh contact_id — the operator may have created the contact
      // between ticks.
      await this.db
        .from('x_dm_threads')
        .update({
          has_unread: thread.hasUnread ? 1 : 0,
          last_seen_at: nowIso,
          counterparty_user_id: resolution.counterpartyUserId,
          contact_id: resolution.contactId,
        })
        .eq('id', existing.id);
    }

    if (!previewChanged) return { previewChanged: false };

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
      return { previewChanged: false };
    }

    this.appendJsonl({
      kind: 'thread_observation',
      ts: nowIso,
      pair: thread.pair,
      primary_name: thread.primaryName,
      preview: thread.preview,
      preview_hash: previewHash,
      has_unread: thread.hasUnread,
      first_seen: isNew,
    });
    return { previewChanged: true };
  }

  /**
   * Open a thread, scrape messages, insert any not-yet-stored ones.
   * Returns the count of newly-stored messages, or null on a thread-
   * read failure (the next tick will retry naturally).
   *
   * Side-effects:
   *   - Inserts new rows into x_dm_messages keyed on X's message UUID.
   *   - Updates x_dm_threads with the conversation_name from the
   *     in-thread header (more reliable than the inbox-row name) and
   *     stamps last_message_id/text/direction with the newest message.
   *   - Appends a JSONL line per new message for greppable history.
   */
  private async ingestThreadBodies(
    thread: DmThreadSummary,
    resolution: CounterpartyResolution,
  ): Promise<number | null> {
    const result = await withCdpLane(
      this.workspaceId,
      () => this.threadReader({
        conversationPair: thread.pair,
        limit: THREAD_READ_LIMIT,
      }),
      { label: 'x-dm-poller:thread-read' },
    );
    if (!result.success || !result.messages) {
      logger.warn(
        { pair: thread.pair, message: result.message },
        '[XDmPollerScheduler] thread read failed',
      );
      return null;
    }

    const nowIso = new Date().toISOString();
    let newCount = 0;
    let signalCount = 0;
    let newest: DmMessage | null = null;
    for (const msg of result.messages) {
      newest = msg;
      let inserted = false;
      try {
        await this.db.from('x_dm_messages').insert({
          workspace_id: this.workspaceId,
          conversation_pair: thread.pair,
          message_id: msg.id,
          direction: msg.direction,
          text: msg.text,
          is_media: msg.isMedia ? 1 : 0,
          observed_at: nowIso,
        });
        newCount++;
        inserted = true;
        this.appendJsonl({
          kind: 'message',
          ts: nowIso,
          pair: thread.pair,
          message_id: msg.id,
          direction: msg.direction,
          text: msg.text,
          is_media: msg.isMedia,
        });
      } catch (err) {
        // UNIQUE(workspace_id, message_id) collision = already stored
        // (the common case on every tick). Don't log per row; only the
        // unexpected (e.g. NOT NULL violation) matters here.
        const errMsg = err instanceof Error ? err.message : String(err);
        if (!/UNIQUE|constraint/i.test(errMsg)) {
          logger.debug({ err: errMsg, pair: thread.pair, msgId: msg.id }, '[XDmPollerScheduler] message insert failed');
        }
      }
      // Signal emission: only on freshly-inserted inbound messages.
      // The signal table dedups via UNIQUE (workspace_id, message_id,
      // signal_type), so re-runs are safe even if `inserted` were a
      // false positive.
      if (inserted && msg.direction === 'inbound') {
        if (!msg.isMedia && msg.text) {
          const wroteSignal = await this.maybeEmitTriggerSignal({
            pair: thread.pair,
            message_id: msg.id,
            text: msg.text,
            primary_name: result.conversationName ?? thread.primaryName,
            observed_at: nowIso,
            contact_id: resolution.contactId,
          });
          if (wroteSignal) signalCount++;
        }
        // Unknown-correspondent signal: the counterparty is resolvable
        // (self id configured) but we have no contact row for them.
        // Operator can create the contact via ohwow_create_contact;
        // the next tick's ingestThread patches contact_id onto the
        // thread and this branch stops firing.
        if (resolution.counterpartyUserId && !resolution.contactId) {
          const wroteUnknown = await this.maybeEmitUnknownCorrespondent({
            pair: thread.pair,
            message_id: msg.id,
            text: msg.text ?? null,
            primary_name: result.conversationName ?? thread.primaryName,
            observed_at: nowIso,
          });
          if (wroteUnknown) signalCount++;
        }
      }
    }
    if (signalCount > 0) {
      logger.info(
        { pair: thread.pair, count: signalCount },
        '[XDmPollerScheduler] signals emitted',
      );
    }

    // Promote the in-thread header name (more accurate than the inbox
    // row's text) and stamp the newest message snapshot on the thread.
    const threadPatch: Record<string, unknown> = { last_seen_at: nowIso };
    if (result.conversationName) threadPatch.primary_name = result.conversationName;
    if (newest) {
      threadPatch.last_message_id = newest.id;
      threadPatch.last_message_text = newest.text;
      threadPatch.last_message_direction = newest.direction;
    }
    await this.db.from('x_dm_threads')
      .update(threadPatch)
      .eq('workspace_id', this.workspaceId)
      .eq('conversation_pair', thread.pair);

    return newCount;
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

  /**
   * Insert one x_dm_signals row for an inbound message that matches a
   * trigger phrase. Returns true when a row was newly written; false
   * when no phrase matched OR the UNIQUE dedup short-circuited an
   * already-known signal.
   *
   * Why we run this only on freshly-inserted messages: the signal
   * table's UNIQUE constraint already prevents double-emission, but
   * skipping the detector entirely on known messages saves the
   * substring scan on every tick of long historical threads.
   */
  private async maybeEmitTriggerSignal(args: {
    pair: string;
    message_id: string;
    text: string;
    primary_name: string | null;
    observed_at: string;
    contact_id: string | null;
  }): Promise<boolean> {
    const phrase = detectTriggerPhrase(args.text);
    if (!phrase) return false;
    try {
      await this.db.from('x_dm_signals').insert({
        workspace_id: this.workspaceId,
        conversation_pair: args.pair,
        message_id: args.message_id,
        signal_type: 'trigger_phrase',
        trigger_phrase: phrase,
        primary_name: args.primary_name,
        text: args.text.slice(0, 500),
        contact_id: args.contact_id,
        observed_at: args.observed_at,
      });
      this.appendJsonl({
        kind: 'signal',
        ts: args.observed_at,
        signal_type: 'trigger_phrase',
        pair: args.pair,
        message_id: args.message_id,
        trigger_phrase: phrase,
        primary_name: args.primary_name,
        text: args.text.slice(0, 500),
        contact_id: args.contact_id,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/UNIQUE|constraint/i.test(msg)) {
        logger.debug(
          { err: msg, pair: args.pair, messageId: args.message_id },
          '[XDmPollerScheduler] signal insert failed',
        );
      }
      return false;
    }
  }

  /**
   * Emit one x_dm_signals row with signal_type='unknown_correspondent'
   * for an inbound message on a thread whose counterparty is known
   * (numeric user id recoverable) but has no matching contact row.
   *
   * The UNIQUE(workspace_id, message_id, signal_type) constraint dedups
   * across ticks — an unmatched thread emits one signal per new
   * inbound message until the operator creates the contact, after
   * which the resolver caches contact_id and this branch stops firing.
   */
  private async maybeEmitUnknownCorrespondent(args: {
    pair: string;
    message_id: string;
    text: string | null;
    primary_name: string | null;
    observed_at: string;
  }): Promise<boolean> {
    try {
      await this.db.from('x_dm_signals').insert({
        workspace_id: this.workspaceId,
        conversation_pair: args.pair,
        message_id: args.message_id,
        signal_type: 'unknown_correspondent',
        trigger_phrase: null,
        primary_name: args.primary_name,
        text: args.text ? args.text.slice(0, 500) : null,
        contact_id: null,
        observed_at: args.observed_at,
      });
      this.appendJsonl({
        kind: 'signal',
        ts: args.observed_at,
        signal_type: 'unknown_correspondent',
        pair: args.pair,
        message_id: args.message_id,
        primary_name: args.primary_name,
        text: args.text ? args.text.slice(0, 500) : null,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/UNIQUE|constraint/i.test(msg)) {
        logger.debug(
          { err: msg, pair: args.pair, messageId: args.message_id },
          '[XDmPollerScheduler] unknown_correspondent signal insert failed',
        );
      }
      return false;
    }
  }

  /**
   * Given a conversation_pair and the configured self user id, derive
   * the counterparty user id and look up their contact row. Runs once
   * per thread per tick; cheap even on 50-thread inboxes because
   * agent_workforce_contacts is small and indexed by workspace_id.
   */
  private async resolveCounterparty(
    pair: string,
    selfUserId: string | null,
    primaryName: string | null,
  ): Promise<CounterpartyResolution> {
    const counterpartyUserId = selfUserId ? pickCounterpartyId(pair, selfUserId) : null;

    // Idempotent upsert — every DM thread becomes a CRM contact. Falls
    // back to conversation_pair keying when the operator's self user id
    // isn't configured yet. If creation fails (DB error), we still
    // proceed: the thread ingests without a contact_id and we try again
    // next tick.
    const contactId = await upsertContactFromDm(this.db, this.workspaceId, {
      conversationPair: pair,
      primaryName,
      counterpartyUserId,
    });

    // Also try the legacy direct lookup so callers that only care about
    // x_user_id → contact still get a consistent result when the row
    // was created outside this helper (e.g. by the operator manually).
    if (!contactId && counterpartyUserId) {
      const contact: ContactRow | null = await findContactByXUserId(
        this.db, this.workspaceId, counterpartyUserId,
      );
      return { counterpartyUserId, contactId: contact?.id ?? null };
    }

    return { counterpartyUserId, contactId };
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
