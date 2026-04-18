/**
 * Integration test: XDmPollerScheduler against a real SQLite DB
 * with the full schema migrated and a fake inbox lister.
 *
 * Covers:
 *   - first-tick: inserts thread + observation + JSONL line per pair
 *   - second-tick with same previews: no new observations, thread
 *     last_seen_at advances
 *   - preview text changes: new observation appended, thread row
 *     updated with bumped observation_count
 *   - has_unread flips without preview change: thread row updated
 *     but no new observation
 *   - lister failure: tick logs and returns without throwing
 *   - dedup: duplicate threads in one tick result are tolerated
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

import { initDatabase } from '../../db/init.js';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import {
  _resetCdpLanesForTests,
  _inspectCdpLaneForTests,
  withCdpLane,
} from '../../execution/browser/cdp-lane.js';
import {
  _resetRuntimeConfigCacheForTests,
  _seedRuntimeConfigCacheForTests,
} from '../../self-bench/runtime-config.js';
import {
  pickCounterpartyId,
  X_SELF_USER_ID_CONFIG_KEY,
  XDmPollerScheduler,
} from '../x-dm-poller-scheduler.js';
import type {
  DmMessage,
  ListDmsResult,
  ReadDmThreadResult,
} from '../../orchestrator/tools/x-posting.js';

const WORKSPACE_ID = 'ws-dm-poll-1';

interface Env {
  dir: string;
  rawDb: Database.Database;
  db: ReturnType<typeof createSqliteAdapter>;
}

function setupEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ohwow-dm-poll-'));
  const rawDb = initDatabase(join(dir, 'runtime.db'));
  const db = createSqliteAdapter(rawDb);
  return { dir, rawDb, db };
}

function teardownEnv(env: Env): void {
  env.rawDb.close();
  rmSync(env.dir, { recursive: true, force: true });
}

function listerOf(result: ListDmsResult): () => Promise<ListDmsResult> {
  return vi.fn().mockResolvedValue(result);
}

function readerOf(
  resultsByPair: Record<string, ReadDmThreadResult>,
): (input: { conversationPair: string }) => Promise<ReadDmThreadResult> {
  return vi.fn(async ({ conversationPair }) =>
    resultsByPair[conversationPair] ?? {
      success: false,
      message: `no fixture for ${conversationPair}`,
      conversationName: null,
    },
  );
}

// Default stub for tests that only care about inbox ingestion. Without this,
// the scheduler falls through to the real CDP-driven reader and burns ~10s
// per thread waiting for a Chrome tab that doesn't exist.
const stubReader: (input: { conversationPair: string }) => Promise<ReadDmThreadResult> =
  () => Promise.resolve({
    success: false,
    message: 'stub: do not hit real browser in unit test',
    conversationName: null,
  });

function msg(id: string, text: string, direction: DmMessage['direction'] = 'inbound', isMedia = false): DmMessage {
  return { id, text, direction, isMedia };
}

function todayJsonlPath(dir: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return join(dir, `x-dms-${day}.jsonl`);
}

describe('XDmPollerScheduler', () => {
  let env: Env;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    teardownEnv(env);
    _resetCdpLanesForTests();
    _resetRuntimeConfigCacheForTests();
  });

  it('first tick inserts thread, observation, and JSONL line per pair', async () => {
    const lister = listerOf({
      success: true,
      message: 'ok',
      threads: [
        { pair: '1:2', primaryName: 'Alice', preview: 'Hello there', hasUnread: true },
        { pair: '3:4', primaryName: 'Bob', preview: 'Quick question', hasUnread: false },
      ],
    });
    const sched = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      dataDir: env.dir,
      inboxLister: lister,
      threadReader: stubReader,
    });
    await sched.tick();

    const threads = env.rawDb
      .prepare('SELECT conversation_pair, last_preview, has_unread, observation_count FROM x_dm_threads ORDER BY conversation_pair')
      .all() as Array<{ conversation_pair: string; last_preview: string; has_unread: number; observation_count: number }>;
    expect(threads).toEqual([
      { conversation_pair: '1:2', last_preview: 'Hello there', has_unread: 1, observation_count: 1 },
      { conversation_pair: '3:4', last_preview: 'Quick question', has_unread: 0, observation_count: 1 },
    ]);

    const obs = env.rawDb
      .prepare('SELECT conversation_pair, preview_text FROM x_dm_observations ORDER BY conversation_pair')
      .all();
    expect(obs).toHaveLength(2);

    const jsonl = readFileSync(todayJsonlPath(env.dir), 'utf-8').trim().split('\n');
    expect(jsonl).toHaveLength(2);
    const parsed = jsonl.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ pair: expect.any(String), preview: expect.any(String), first_seen: true });
  });

  it('second tick with identical previews writes no new observations', async () => {
    const lister = listerOf({
      success: true,
      message: 'ok',
      threads: [{ pair: '1:2', primaryName: 'Alice', preview: 'Same as before', hasUnread: false }],
    });
    const sched = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      dataDir: env.dir,
      inboxLister: lister,
      threadReader: stubReader,
    });
    await sched.tick();
    await sched.tick();

    const obsCount = (env.rawDb
      .prepare('SELECT COUNT(*) as n FROM x_dm_observations')
      .get() as { n: number }).n;
    expect(obsCount).toBe(1);

    const thread = env.rawDb
      .prepare('SELECT observation_count FROM x_dm_threads')
      .get() as { observation_count: number };
    expect(thread.observation_count).toBe(1);
  });

  it('changed preview appends a new observation and bumps observation_count', async () => {
    const firstLister = listerOf({
      success: true,
      message: 'ok',
      threads: [{ pair: '1:2', primaryName: 'Alice', preview: 'First message', hasUnread: false }],
    });
    const sched1 = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      dataDir: env.dir,
      inboxLister: firstLister,
      threadReader: stubReader,
    });
    await sched1.tick();

    const secondLister = listerOf({
      success: true,
      message: 'ok',
      threads: [{ pair: '1:2', primaryName: 'Alice', preview: 'Second message', hasUnread: true }],
    });
    const sched2 = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      dataDir: env.dir,
      inboxLister: secondLister,
      threadReader: stubReader,
    });
    await sched2.tick();

    const obs = env.rawDb
      .prepare('SELECT preview_text FROM x_dm_observations ORDER BY observed_at')
      .all() as Array<{ preview_text: string }>;
    expect(obs.map((o) => o.preview_text)).toEqual(['First message', 'Second message']);

    const thread = env.rawDb
      .prepare('SELECT observation_count, has_unread FROM x_dm_threads')
      .get() as { observation_count: number; has_unread: number };
    expect(thread.observation_count).toBe(2);
    expect(thread.has_unread).toBe(1);
  });

  it('unread flag flip without preview change updates thread but not observations', async () => {
    const firstLister = listerOf({
      success: true,
      message: 'ok',
      threads: [{ pair: '1:2', primaryName: 'Alice', preview: 'Hello', hasUnread: true }],
    });
    const sched1 = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      dataDir: env.dir,
      inboxLister: firstLister,
      threadReader: stubReader,
    });
    await sched1.tick();

    const secondLister = listerOf({
      success: true,
      message: 'ok',
      threads: [{ pair: '1:2', primaryName: 'Alice', preview: 'Hello', hasUnread: false }],
    });
    const sched2 = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      dataDir: env.dir,
      inboxLister: secondLister,
      threadReader: stubReader,
    });
    await sched2.tick();

    const obsCount = (env.rawDb
      .prepare('SELECT COUNT(*) as n FROM x_dm_observations')
      .get() as { n: number }).n;
    expect(obsCount).toBe(1);

    const thread = env.rawDb
      .prepare('SELECT has_unread, observation_count FROM x_dm_threads')
      .get() as { has_unread: number; observation_count: number };
    expect(thread.has_unread).toBe(0);
    expect(thread.observation_count).toBe(1);
  });

  it('lister failure does not throw and writes nothing', async () => {
    const lister = listerOf({
      success: false,
      message: 'CDP attach failed',
    });
    const sched = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      dataDir: env.dir,
      inboxLister: lister,
      threadReader: stubReader,
    });
    await expect(sched.tick()).resolves.toBeUndefined();

    const n = (env.rawDb
      .prepare('SELECT COUNT(*) as n FROM x_dm_threads')
      .get() as { n: number }).n;
    expect(n).toBe(0);
    expect(existsSync(todayJsonlPath(env.dir))).toBe(false);
  });

  it('omitting dataDir skips JSONL writes but DB writes still happen', async () => {
    const lister = listerOf({
      success: true,
      message: 'ok',
      threads: [{ pair: '1:2', primaryName: 'Alice', preview: 'Hi', hasUnread: false }],
    });
    const sched = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      inboxLister: lister,
      threadReader: stubReader,
    });
    await sched.tick();

    const n = (env.rawDb
      .prepare('SELECT COUNT(*) as n FROM x_dm_threads')
      .get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('enters changed/unread threads and stores per-message bodies', async () => {
    const lister = listerOf({
      success: true,
      message: 'ok',
      threads: [
        { pair: '1:2', primaryName: 'Alice teaser', preview: 'Hey there', hasUnread: true },
        { pair: '3:4', primaryName: 'Bob teaser', preview: 'Old message', hasUnread: false },
      ],
    });
    const reader = readerOf({
      '1:2': {
        success: true, message: 'ok', conversationName: 'Alice (canonical)',
        messages: [
          msg('uuid-a1', 'Hey there', 'inbound'),
          msg('uuid-a2', 'Following up', 'inbound'),
          msg('uuid-a3', 'Got it', 'outbound'),
        ],
      },
      '3:4': {
        success: true, message: 'ok', conversationName: 'Bob (canonical)',
        messages: [msg('uuid-b1', 'Old message', 'inbound')],
      },
    });
    const sched = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      dataDir: env.dir,
      inboxLister: lister,
      threadReader: reader,
    });
    await sched.tick();

    // 1:2 was unread → entered. 3:4 unread=false but preview never seen → also entered.
    expect(reader).toHaveBeenCalledTimes(2);

    const messages = env.rawDb
      .prepare('SELECT message_id, direction, text FROM x_dm_messages ORDER BY message_id')
      .all() as Array<{ message_id: string; direction: string; text: string }>;
    expect(messages).toHaveLength(4);
    const a3 = messages.find((m) => m.message_id === 'uuid-a3');
    expect(a3?.direction).toBe('outbound');

    // Thread row picks up the canonical name from the in-thread header.
    const threads = env.rawDb
      .prepare('SELECT conversation_pair, primary_name, last_message_id, last_message_text, last_message_direction FROM x_dm_threads ORDER BY conversation_pair')
      .all() as Array<{ conversation_pair: string; primary_name: string; last_message_id: string; last_message_text: string; last_message_direction: string }>;
    expect(threads[0]).toMatchObject({
      conversation_pair: '1:2',
      primary_name: 'Alice (canonical)',
      last_message_id: 'uuid-a3',
      last_message_text: 'Got it',
      last_message_direction: 'outbound',
    });
  });

  it('previously-seen messages are deduped by message_id across ticks', async () => {
    const lister = listerOf({
      success: true,
      message: 'ok',
      threads: [{ pair: '1:2', primaryName: 'Alice', preview: 'm1', hasUnread: true }],
    });
    const reader = readerOf({
      '1:2': {
        success: true, message: 'ok', conversationName: 'Alice',
        messages: [msg('uuid-1', 'm1'), msg('uuid-2', 'm2')],
      },
    });
    const sched1 = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      inboxLister: lister, threadReader: reader,
    });
    await sched1.tick();

    // Second tick: same messages + one new one. Preview changed so we
    // re-enter the thread.
    const lister2 = listerOf({
      success: true,
      message: 'ok',
      threads: [{ pair: '1:2', primaryName: 'Alice', preview: 'm3', hasUnread: true }],
    });
    const reader2 = readerOf({
      '1:2': {
        success: true, message: 'ok', conversationName: 'Alice',
        messages: [msg('uuid-1', 'm1'), msg('uuid-2', 'm2'), msg('uuid-3', 'm3')],
      },
    });
    const sched2 = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      inboxLister: lister2, threadReader: reader2,
    });
    await sched2.tick();

    const n = (env.rawDb
      .prepare('SELECT COUNT(*) as n FROM x_dm_messages')
      .get() as { n: number }).n;
    expect(n).toBe(3);
  });

  it('caps per-tick thread reads at MAX_THREADS_READ_PER_TICK', async () => {
    const threadCount = 12;
    const inboxThreads = Array.from({ length: threadCount }, (_, i) => ({
      pair: `${i}a:${i}b`, primaryName: `t${i}`, preview: `p${i}`, hasUnread: true,
    }));
    const lister = listerOf({ success: true, message: 'ok', threads: inboxThreads });
    const fixtures: Record<string, ReadDmThreadResult> = {};
    for (const t of inboxThreads) {
      fixtures[t.pair] = {
        success: true, message: 'ok', conversationName: t.primaryName,
        messages: [msg(`m-${t.pair}`, 'hello')],
      };
    }
    const reader = readerOf(fixtures);
    const sched = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      inboxLister: lister, threadReader: reader,
    });
    await sched.tick();

    // Source of truth: only 8 threads should have been read this tick.
    expect(reader).toHaveBeenCalledTimes(8);
    const messageCount = (env.rawDb
      .prepare('SELECT COUNT(*) as n FROM x_dm_messages')
      .get() as { n: number }).n;
    expect(messageCount).toBe(8);
  });

  it('emits x_dm_signals rows for inbound trigger-phrase hits only', async () => {
    const lister = listerOf({
      success: true,
      message: 'ok',
      threads: [{ pair: '1:2', primaryName: 'Alice', preview: 'pricing q', hasUnread: true }],
    });
    const reader = readerOf({
      '1:2': {
        success: true, message: 'ok', conversationName: 'Alice Canonical',
        messages: [
          msg('uuid-1', 'Hey, quick question about pricing?', 'inbound'),
          msg('uuid-2', 'We posted demo details yesterday', 'outbound'), // outbound — must not signal
          msg('uuid-3', 'Sent you a demo video', 'inbound', true),      // media — must not signal
          msg('uuid-4', 'Just saying hi', 'inbound'),                   // no trigger
          msg('uuid-5', 'Interested in onboarding for the team', 'inbound'),
        ],
      },
    });
    const sched = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      dataDir: env.dir,
      inboxLister: lister,
      threadReader: reader,
    });
    await sched.tick();

    const signals = env.rawDb
      .prepare('SELECT message_id, trigger_phrase, primary_name FROM x_dm_signals ORDER BY message_id')
      .all() as Array<{ message_id: string; trigger_phrase: string; primary_name: string }>;
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => [s.message_id, s.trigger_phrase])).toEqual([
      ['uuid-1', 'pricing'],
      ['uuid-5', 'onboarding'],
    ]);
    // Signal carries the in-thread header name, not the inbox row name.
    expect(signals[0].primary_name).toBe('Alice Canonical');
  });

  it('does not re-emit signals for messages seen on a prior tick', async () => {
    const lister = listerOf({
      success: true,
      message: 'ok',
      threads: [{ pair: '1:2', primaryName: 'Alice', preview: 'pricing q', hasUnread: true }],
    });
    const reader = readerOf({
      '1:2': {
        success: true, message: 'ok', conversationName: 'Alice',
        messages: [msg('uuid-1', 'Need pricing info', 'inbound')],
      },
    });
    const sched1 = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      inboxLister: lister, threadReader: reader,
    });
    await sched1.tick();

    const lister2 = listerOf({
      success: true,
      message: 'ok',
      threads: [{ pair: '1:2', primaryName: 'Alice', preview: 'followup', hasUnread: true }],
    });
    const reader2 = readerOf({
      '1:2': {
        success: true, message: 'ok', conversationName: 'Alice',
        // Same message as before + a new one that doesn't trigger.
        messages: [
          msg('uuid-1', 'Need pricing info', 'inbound'),
          msg('uuid-2', 'thanks for the reply', 'inbound'),
        ],
      },
    });
    const sched2 = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      inboxLister: lister2, threadReader: reader2,
    });
    await sched2.tick();

    const n = (env.rawDb
      .prepare('SELECT COUNT(*) as n FROM x_dm_signals')
      .get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('skips entering threads that are already known and unchanged', async () => {
    // First tick: ingest one thread + body.
    const initialLister = listerOf({
      success: true,
      message: 'ok',
      threads: [{ pair: '1:2', primaryName: 'Alice', preview: 'Same preview', hasUnread: false }],
    });
    const initialReader = readerOf({
      '1:2': {
        success: true, message: 'ok', conversationName: 'Alice',
        messages: [msg('uuid-1', 'm1')],
      },
    });
    const sched1 = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      inboxLister: initialLister, threadReader: initialReader,
    });
    await sched1.tick();
    expect(initialReader).toHaveBeenCalledTimes(1);

    // Second tick: same preview, not unread. Reader should NOT be called.
    const noopReader = vi.fn();
    const sched2 = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      inboxLister: listerOf({
        success: true,
        message: 'ok',
        threads: [{ pair: '1:2', primaryName: 'Alice', preview: 'Same preview', hasUnread: false }],
      }),
      threadReader: noopReader,
    });
    await sched2.tick();
    expect(noopReader).not.toHaveBeenCalled();
  });

  describe('contact linking', () => {
    const SELF = '1111111111';
    const ALICE = '2222222222';
    const BOB = '3333333333';

    function seedContact(name: string, xUserId: string): string {
      const id = `contact-${name}`;
      env.rawDb.prepare(
        `INSERT INTO agent_workforce_contacts (id, workspace_id, name, custom_fields)
         VALUES (?, ?, ?, ?)`,
      ).run(id, WORKSPACE_ID, name, JSON.stringify({ x_user_id: xUserId }));
      return id;
    }

    it('stamps counterparty_user_id + contact_id on threads when self id is configured', async () => {
      _seedRuntimeConfigCacheForTests(X_SELF_USER_ID_CONFIG_KEY, SELF);
      const aliceId = seedContact('Alice', ALICE);

      const lister = listerOf({
        success: true,
        message: 'ok',
        threads: [
          { pair: `${SELF}:${ALICE}`, primaryName: 'Alice', preview: 'hi', hasUnread: false },
          { pair: `${SELF}:${BOB}`, primaryName: 'Bob', preview: 'yo', hasUnread: false },
        ],
      });
      const sched = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
        inboxLister: lister,
        threadReader: readerOf({}),
      });
      await sched.tick();

      const rows = env.rawDb.prepare(
        'SELECT conversation_pair, counterparty_user_id, contact_id FROM x_dm_threads ORDER BY conversation_pair',
      ).all() as Array<{ conversation_pair: string; counterparty_user_id: string; contact_id: string | null }>;
      // Alice pre-seeded → matches via x_user_id lookup, returns aliceId.
      // Bob unseeded → auto-upsert (c3acc05) creates a fresh CRM contact,
      // so contact_id is any non-null string.
      expect(rows).toEqual([
        { conversation_pair: `${SELF}:${ALICE}`, counterparty_user_id: ALICE, contact_id: aliceId },
        {
          conversation_pair: `${SELF}:${BOB}`,
          counterparty_user_id: BOB,
          contact_id: expect.any(String),
        },
      ]);
      expect(rows[1].contact_id).not.toBe(aliceId);
    });

    it('auto-creates a contact via conversation_pair when self id is not configured', async () => {
      // No _seedRuntimeConfigCacheForTests call — cache is empty.
      const lister = listerOf({
        success: true,
        message: 'ok',
        threads: [{ pair: `${SELF}:${ALICE}`, primaryName: 'Alice', preview: 'hi', hasUnread: false }],
      });
      const sched = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
        inboxLister: lister,
        threadReader: readerOf({}),
      });
      await sched.tick();

      const row = env.rawDb.prepare(
        'SELECT counterparty_user_id, contact_id FROM x_dm_threads',
      ).get() as { counterparty_user_id: string | null; contact_id: string | null };
      // counterparty_user_id still null (no self id to pick from pair),
      // but upsertContactFromDm falls back to conversation_pair keying
      // and creates a lead contact for the thread.
      expect(row.counterparty_user_id).toBeNull();
      expect(row.contact_id).toEqual(expect.any(String));
    });

    it('keeps the auto-created pair contact stable across ticks', async () => {
      _seedRuntimeConfigCacheForTests(X_SELF_USER_ID_CONFIG_KEY, SELF);
      const lister = listerOf({
        success: true,
        message: 'ok',
        threads: [{ pair: `${SELF}:${ALICE}`, primaryName: 'Alice', preview: 'hi', hasUnread: false }],
      });
      const sched = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
        inboxLister: lister,
        threadReader: readerOf({}),
      });
      await sched.tick();

      // First tick auto-creates a CRM contact keyed on x_user_id + pair
      // (c3acc05: DMs always auto-create CRM contacts).
      const before = env.rawDb
        .prepare('SELECT contact_id FROM x_dm_threads')
        .get() as { contact_id: string | null };
      expect(before.contact_id).toEqual(expect.any(String));

      // A second tick with the same thread finds the same contact via
      // findContactByXUserId (since the auto-upsert already stamped
      // x_user_id on the contact's custom_fields). contact_id is stable.
      await sched.tick();

      const after = env.rawDb
        .prepare('SELECT contact_id FROM x_dm_threads')
        .get() as { contact_id: string | null };
      expect(after.contact_id).toBe(before.contact_id);
    });

    it('does not emit unknown_correspondent — auto-upsert always gives threads a contact', async () => {
      // Since c3acc05 (DMs always auto-create CRM contacts) the resolve
      // path fills contact_id for every thread. The unknown_correspondent
      // signal's emission condition (`counterpartyUserId && !contactId`)
      // only hits on a DB error during upsert, so in the happy path it
      // never fires. This test documents that new invariant.
      _seedRuntimeConfigCacheForTests(X_SELF_USER_ID_CONFIG_KEY, SELF);
      const pair = `${SELF}:${ALICE}`;

      const sched = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
        dataDir: env.dir,
        inboxLister: listerOf({
          success: true,
          message: 'ok',
          threads: [{ pair, primaryName: 'Alice', preview: 'first', hasUnread: true }],
        }),
        threadReader: readerOf({
          [pair]: {
            success: true,
            message: 'ok',
            conversationName: 'Alice',
            messages: [msg('m1', 'Hey there')],
          },
        }),
      });
      await sched.tick();

      const sigs = env.rawDb
        .prepare(
          'SELECT message_id, signal_type, contact_id FROM x_dm_signals WHERE signal_type = ?',
        )
        .all('unknown_correspondent') as Array<{
          message_id: string;
          signal_type: string;
          contact_id: string | null;
        }>;
      expect(sigs).toEqual([]);

      // Thread row is linked to the auto-created contact.
      const thread = env.rawDb
        .prepare('SELECT contact_id FROM x_dm_threads')
        .get() as { contact_id: string | null };
      expect(thread.contact_id).toEqual(expect.any(String));
    });

    it('includes contact_id on trigger_phrase signals when the counterparty is linked', async () => {
      _seedRuntimeConfigCacheForTests(X_SELF_USER_ID_CONFIG_KEY, SELF);
      const aliceId = seedContact('Alice', ALICE);
      const pair = `${SELF}:${ALICE}`;

      const sched = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
        dataDir: env.dir,
        inboxLister: listerOf({
          success: true,
          message: 'ok',
          threads: [{ pair, primaryName: 'Alice', preview: 'new', hasUnread: true }],
        }),
        threadReader: readerOf({
          [pair]: {
            success: true,
            message: 'ok',
            conversationName: 'Alice',
            // Message contains a trigger phrase ("pricing") — the
            // existing detector will fire.
            messages: [msg('m1', 'what are your pricing options?')],
          },
        }),
      });
      await sched.tick();

      const sigs = env.rawDb.prepare(
        'SELECT signal_type, contact_id FROM x_dm_signals WHERE message_id=? ORDER BY signal_type',
      ).all('m1') as Array<{ signal_type: string; contact_id: string | null }>;
      // Linked thread: trigger_phrase emitted with contact_id; no
      // unknown_correspondent.
      expect(sigs).toEqual([
        { signal_type: 'trigger_phrase', contact_id: aliceId },
      ]);
    });
  });

  describe('pickCounterpartyId', () => {
    it('splits colon-pair and returns the half that isn\'t self', () => {
      expect(pickCounterpartyId('1:2', '1')).toBe('2');
      expect(pickCounterpartyId('1:2', '2')).toBe('1');
    });
    it('supports hyphen-pair (URL format)', () => {
      expect(pickCounterpartyId('1-2', '1')).toBe('2');
    });
    it('returns null when self id is not in the pair', () => {
      expect(pickCounterpartyId('1:2', '999')).toBeNull();
    });
    it('returns null on malformed pair or empty self id', () => {
      expect(pickCounterpartyId('solo', '1')).toBeNull();
      expect(pickCounterpartyId('', '1')).toBeNull();
      expect(pickCounterpartyId('1:2', '')).toBeNull();
    });
  });

  it('waits on the CDP lane when it is held by another caller', async () => {
    let sawListerCall = false;
    const lister = vi.fn(async () => {
      sawListerCall = true;
      return {
        success: true,
        message: 'ok',
        threads: [{ pair: '1:2', primaryName: 'Alice', preview: 'Hi', hasUnread: false }],
      } satisfies ListDmsResult;
    });
    const threadReader = vi.fn(async () => ({
      success: false as const,
      message: 'stub: do not hit real browser in unit test',
      conversationName: null,
    }));
    const sched = new XDmPollerScheduler(env.db, WORKSPACE_ID, {
      dataDir: env.dir,
      inboxLister: lister,
      threadReader,
    });

    let release!: () => void;
    const holderDone = withCdpLane(
      WORKSPACE_ID,
      () => new Promise<void>((resolve) => { release = resolve; }),
      { label: 'test-holder' },
    );
    await Promise.resolve();
    expect(_inspectCdpLaneForTests(WORKSPACE_ID).held).toBe(true);

    const tickPromise = sched.tick();
    // yield twice so the poller's withCdpLane call enqueues behind the holder
    await Promise.resolve();
    await Promise.resolve();

    expect(sawListerCall).toBe(false);
    expect(_inspectCdpLaneForTests(WORKSPACE_ID).queueDepth).toBe(1);

    release();
    await holderDone;
    await tickPromise;

    expect(sawListerCall).toBe(true);
    expect(_inspectCdpLaneForTests(WORKSPACE_ID)).toEqual({ held: false, queueDepth: 0 });
  });
});
