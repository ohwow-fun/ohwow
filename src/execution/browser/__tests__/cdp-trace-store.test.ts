/**
 * Unit test: cdp-trace-store singleton
 *
 * Verifies:
 *   - insertCdpTraceEvent silently no-ops when db is uninitialized (never throws)
 *   - after initCdpTraceDb, an insert reaches the db
 *   - _resetCdpTraceDb clears the singleton (insert no-ops again)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  initCdpTraceDb,
  _resetCdpTraceDb,
  insertCdpTraceEvent,
} from '../cdp-trace-store.js';
import type { DatabaseAdapter } from '../../../db/adapter-types.js';

afterEach(() => {
  _resetCdpTraceDb();
});

// ── Minimal DatabaseAdapter stub ─────────────────────────────────────────────

function makeDbStub(insertError: unknown = null) {
  const insertThen = vi.fn().mockImplementation(
    (resolve: (v: { data: null; error: unknown }) => void) =>
      resolve({ data: null, error: insertError }),
  );
  const insertChain = {
    select: vi.fn().mockReturnValue({ single: vi.fn() }),
    then: insertThen,
  };
  const insertFn = vi.fn().mockReturnValue(insertChain);

  const fromFn = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ then: vi.fn() }) }),
    insert: insertFn,
  });

  const db = { from: fromFn, rpc: vi.fn() };

  return { db, insertFn, fromFn };
}

// ── no-op when uninitialized ─────────────────────────────────────────────────

describe('insertCdpTraceEvent (uninitialized)', () => {
  it('does not throw when db is not initialized', () => {
    expect(() => insertCdpTraceEvent({ action: 'claim' })).not.toThrow();
  });

  it('returns void synchronously when db is not initialized', () => {
    const result = insertCdpTraceEvent({ action: 'browser:open', profile: 'Default' });
    expect(result).toBeUndefined();
  });
});

// ── insert reaches db after init ─────────────────────────────────────────────

describe('insertCdpTraceEvent (initialized)', () => {
  it('calls db.from("cdp_trace_events").insert after init', async () => {
    const { db, insertFn, fromFn } = makeDbStub();
    initCdpTraceDb(db as unknown as DatabaseAdapter, 'ws-test');

    insertCdpTraceEvent({ action: 'claim', profile: 'Default', owner: 'task-1' });

    // Fire-and-forget — wait a tick for the async IIFE to run
    await new Promise(r => setTimeout(r, 0));

    expect(fromFn).toHaveBeenCalledWith('cdp_trace_events');
    expect(insertFn).toHaveBeenCalledTimes(1);

    const insertedRow = insertFn.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedRow.action).toBe('claim');
    expect(insertedRow.profile).toBe('Default');
    expect(insertedRow.owner).toBe('task-1');
    expect(insertedRow.workspace_id).toBe('ws-test');
    expect(typeof insertedRow.id).toBe('string');
    expect(typeof insertedRow.ts).toBe('string');
  });

  it('puts unknown keys into metadata_json', async () => {
    const { db, insertFn } = makeDbStub();
    initCdpTraceDb(db as unknown as DatabaseAdapter, 'ws-test');

    insertCdpTraceEvent({ action: 'navigate', url: 'https://example.com', tabIndex: 3, phase: 'init' });

    await new Promise(r => setTimeout(r, 0));

    const row = insertFn.mock.calls[0][0] as Record<string, unknown>;
    expect(row.url).toBe('https://example.com');
    const meta = JSON.parse(row.metadata_json as string) as Record<string, unknown>;
    expect(meta.tabIndex).toBe(3);
    expect(meta.phase).toBe('init');
  });

  it('sets metadata_json to null when no extra fields', async () => {
    const { db, insertFn } = makeDbStub();
    initCdpTraceDb(db as unknown as DatabaseAdapter, 'ws-test');

    insertCdpTraceEvent({ action: 'release', profile: 'Default' });

    await new Promise(r => setTimeout(r, 0));

    const row = insertFn.mock.calls[0][0] as Record<string, unknown>;
    expect(row.metadata_json).toBeNull();
  });

  it('does not throw even when db.insert fails', async () => {
    const { db } = makeDbStub(new Error('disk full'));
    initCdpTraceDb(db as unknown as DatabaseAdapter, 'ws-test');

    // Should not throw — errors are swallowed
    expect(() => insertCdpTraceEvent({ action: 'tab:attach' })).not.toThrow();
    await new Promise(r => setTimeout(r, 10));
    // No error bubbles out
  });
});

// ── _resetCdpTraceDb ─────────────────────────────────────────────────────────

describe('_resetCdpTraceDb', () => {
  it('clears the singleton so subsequent inserts no-op', async () => {
    const { db, insertFn } = makeDbStub();
    initCdpTraceDb(db as unknown as DatabaseAdapter, 'ws-test');
    _resetCdpTraceDb();

    insertCdpTraceEvent({ action: 'claim' });
    await new Promise(r => setTimeout(r, 0));

    expect(insertFn).not.toHaveBeenCalled();
  });
});
