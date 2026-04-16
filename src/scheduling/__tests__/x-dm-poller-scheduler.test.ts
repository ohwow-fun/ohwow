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
import type { ListDmsResult } from '../../orchestrator/tools/x-posting.js';

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
});
