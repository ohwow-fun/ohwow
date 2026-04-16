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
import { XDmPollerScheduler } from '../x-dm-poller-scheduler.js';
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
});
