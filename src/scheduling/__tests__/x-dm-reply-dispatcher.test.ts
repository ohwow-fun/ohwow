import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

import { initDatabase } from '../../db/init.js';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import { _resetCdpLanesForTests } from '../../execution/browser/cdp-lane.js';
import type { SendDmInput, ComposeResult } from '../../orchestrator/tools/x-posting.js';
import { type ApprovalEntry, readApprovalRows } from '../approval-queue.js';
import { XDmReplyDispatcher } from '../x-dm-reply-dispatcher.js';

const WORKSPACE_ID = 'ws-reply-dispatch-1';

interface Env {
  dir: string;
  rawDb: Database.Database;
  db: ReturnType<typeof createSqliteAdapter>;
  jsonl: string;
}

function setupEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ohwow-dm-reply-'));
  const rawDb = initDatabase(join(dir, 'runtime.db'));
  const db = createSqliteAdapter(rawDb);
  const jsonl = join(dir, 'x-approvals.jsonl');
  return { dir, rawDb, db, jsonl };
}

function teardownEnv(env: Env): void {
  env.rawDb.close();
  rmSync(env.dir, { recursive: true, force: true });
}

function seedApproval(jsonl: string, entry: ApprovalEntry): void {
  const exists = (() => {
    try { return readFileSync(jsonl, 'utf-8'); } catch { return ''; }
  })();
  if (exists) {
    appendFileSync(jsonl, JSON.stringify(entry) + '\n');
  } else {
    writeFileSync(jsonl, JSON.stringify(entry) + '\n');
  }
}

function approval(overrides: Partial<ApprovalEntry>): ApprovalEntry {
  return {
    id: `approval-${Math.random().toString(36).slice(2, 10)}`,
    ts: new Date().toISOString(),
    kind: 'x_dm_outbound',
    workspace: WORKSPACE_ID,
    summary: 'Reply to Alice',
    payload: { conversation_pair: '1:2', text: 'Hello back' },
    status: 'approved',
    ...overrides,
  };
}

function seedThread(env: Env, pair: string): void {
  env.rawDb.prepare(
    `INSERT INTO x_dm_threads
      (workspace_id, conversation_pair, primary_name, last_preview, last_preview_hash, has_unread, observation_count, first_seen_at, last_seen_at)
     VALUES (?, ?, 'Alice', '', '', 0, 0, datetime('now'), datetime('now'))`,
  ).run(WORKSPACE_ID, pair);
}

describe('XDmReplyDispatcher', () => {
  let env: Env;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    teardownEnv(env);
    _resetCdpLanesForTests();
  });

  it('sends an approved reply, inserts the outbound message row, and marks the approval applied', async () => {
    const approved = approval({});
    seedApproval(env.jsonl, approved);
    seedThread(env, '1:2');

    const sender = vi.fn(async (input: SendDmInput): Promise<ComposeResult> => ({
      success: true,
      message: `DM sent to ${input.conversationPair}.`,
      landedAt: input.conversationPair,
    }));

    const sched = new XDmReplyDispatcher(env.db, WORKSPACE_ID, {
      approvalsJsonlPath: env.jsonl,
      dataDir: env.dir,
      sender,
    });
    await sched.tick();

    expect(sender).toHaveBeenCalledTimes(1);
    const call = sender.mock.calls[0][0];
    expect(call.conversationPair).toBe('1:2');
    expect(call.text).toBe('Hello back');
    expect(call.dryRun).toBe(false);

    const msgs = env.rawDb.prepare(
      'SELECT conversation_pair, direction, text, message_id FROM x_dm_messages',
    ).all() as Array<{ conversation_pair: string; direction: string; text: string; message_id: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].direction).toBe('outbound');
    expect(msgs[0].text).toBe('Hello back');
    expect(msgs[0].message_id).toMatch(/^outbound-/);

    const thread = env.rawDb.prepare(
      'SELECT last_message_id, last_message_text, last_message_direction FROM x_dm_threads WHERE conversation_pair=?',
    ).get('1:2') as { last_message_id: string; last_message_text: string; last_message_direction: string };
    expect(thread.last_message_direction).toBe('outbound');
    expect(thread.last_message_text).toBe('Hello back');

    const appliedRows = readApprovalRows(env.jsonl).filter((r) => r.id === approved.id);
    const last = appliedRows[appliedRows.length - 1];
    expect(last.status).toBe('applied');
    expect(JSON.parse(last.notes ?? '{}').posted).toBe(true);
  });

  it('does not mark applied when the sender reports failure', async () => {
    const approved = approval({});
    seedApproval(env.jsonl, approved);
    seedThread(env, '1:2');

    const sender = vi.fn(async (): Promise<ComposeResult> => ({
      success: false,
      message: 'DM send button never became clickable within 5s.',
    }));
    const sched = new XDmReplyDispatcher(env.db, WORKSPACE_ID, {
      approvalsJsonlPath: env.jsonl,
      sender,
    });
    await sched.tick();

    const msgs = env.rawDb.prepare('SELECT COUNT(*) as n FROM x_dm_messages').get() as { n: number };
    expect(msgs.n).toBe(0);

    // Latest row for approval id should still be the original approved
    // status (no applied row appended).
    const rows = readApprovalRows(env.jsonl).filter((r) => r.id === approved.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('approved');
  });

  it('skips already-applied approvals on subsequent ticks', async () => {
    const approved = approval({});
    seedApproval(env.jsonl, approved);
    seedThread(env, '1:2');

    const sender = vi.fn(async (input: SendDmInput): Promise<ComposeResult> => ({
      success: true,
      message: 'ok',
      landedAt: input.conversationPair,
    }));
    const sched = new XDmReplyDispatcher(env.db, WORKSPACE_ID, {
      approvalsJsonlPath: env.jsonl,
      sender,
    });

    await sched.tick();
    await sched.tick();

    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('processes multiple approved entries in oldest-first order, capped at MAX_SENDS_PER_TICK', async () => {
    // Create 7 approvals with increasing ts; expect at most 5 sends in one tick.
    const approvals: ApprovalEntry[] = [];
    for (let i = 0; i < 7; i++) {
      const a = approval({
        id: `approval-${i}`,
        ts: new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString(),
        payload: { conversation_pair: `pair-${i}`, text: `msg ${i}` },
      });
      approvals.push(a);
      seedApproval(env.jsonl, a);
      seedThread(env, `pair-${i}`);
    }

    const sender = vi.fn(async (input: SendDmInput): Promise<ComposeResult> => ({
      success: true,
      message: 'ok',
      landedAt: input.conversationPair,
    }));
    const sched = new XDmReplyDispatcher(env.db, WORKSPACE_ID, {
      approvalsJsonlPath: env.jsonl,
      sender,
    });
    await sched.tick();

    expect(sender).toHaveBeenCalledTimes(5);
    // Verify oldest-first ordering
    const pairs = sender.mock.calls.map((c) => c[0].conversationPair);
    expect(pairs).toEqual(['pair-0', 'pair-1', 'pair-2', 'pair-3', 'pair-4']);

    // Second tick drains the remaining 2
    await sched.tick();
    expect(sender).toHaveBeenCalledTimes(7);
  });

  it('marks malformed approval applied so it does not stick forever', async () => {
    const bad = approval({
      id: 'bad-1',
      payload: { text: '' }, // missing pair AND blank text
    });
    seedApproval(env.jsonl, bad);

    const sender = vi.fn();
    const sched = new XDmReplyDispatcher(env.db, WORKSPACE_ID, {
      approvalsJsonlPath: env.jsonl,
      sender,
    });
    await sched.tick();

    expect(sender).not.toHaveBeenCalled();

    const rows = readApprovalRows(env.jsonl).filter((r) => r.id === 'bad-1');
    const last = rows[rows.length - 1];
    expect(last.status).toBe('applied');
    expect(JSON.parse(last.notes ?? '{}').posted).toBe(false);
  });

  it('appends an outbound_sent JSONL line when dataDir is set', async () => {
    const approved = approval({});
    seedApproval(env.jsonl, approved);
    seedThread(env, '1:2');

    const sender = vi.fn(async (input: SendDmInput): Promise<ComposeResult> => ({
      success: true,
      message: 'ok',
      landedAt: input.conversationPair,
    }));
    const sched = new XDmReplyDispatcher(env.db, WORKSPACE_ID, {
      approvalsJsonlPath: env.jsonl,
      dataDir: env.dir,
      sender,
    });
    await sched.tick();

    const day = new Date().toISOString().slice(0, 10);
    const ledgerPath = join(env.dir, `x-dms-${day}.jsonl`);
    const content = readFileSync(ledgerPath, 'utf-8').trim();
    const lines = content.split('\n').map((l) => JSON.parse(l));
    const outbound = lines.filter((l) => l.kind === 'outbound_sent');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({
      kind: 'outbound_sent',
      pair: '1:2',
      text: 'Hello back',
      approval_id: approved.id,
    });
    expect(outbound[0].message_id).toMatch(/^outbound-/);
  });

  it('skips pending and rejected approvals', async () => {
    seedApproval(env.jsonl, approval({ id: 'p', status: 'pending' }));
    seedApproval(env.jsonl, approval({ id: 'r', status: 'rejected' }));

    const sender = vi.fn();
    const sched = new XDmReplyDispatcher(env.db, WORKSPACE_ID, {
      approvalsJsonlPath: env.jsonl,
      sender,
    });
    await sched.tick();

    expect(sender).not.toHaveBeenCalled();
  });

  it('uses handle fallback when no conversation_pair is present', async () => {
    const approved = approval({
      payload: { handle: 'alice', text: 'Hi Alice' },
    });
    seedApproval(env.jsonl, approved);

    const sender = vi.fn(async (): Promise<ComposeResult> => ({
      success: true,
      message: 'ok',
      landedAt: 'resolved-1:2',
    }));
    const sched = new XDmReplyDispatcher(env.db, WORKSPACE_ID, {
      approvalsJsonlPath: env.jsonl,
      sender,
    });
    await sched.tick();

    expect(sender).toHaveBeenCalledWith(expect.objectContaining({
      handle: 'alice',
      conversationPair: undefined,
      text: 'Hi Alice',
      dryRun: false,
    }));
  });
});
