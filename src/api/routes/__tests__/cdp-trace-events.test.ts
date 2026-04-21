/**
 * Integration test: GET /api/cdp-trace-events
 *
 * Tests the Express route against a real in-memory SQLite adapter with
 * fixture rows.  Uses the direct handler invocation pattern (no supertest).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Request, Response } from 'express';
import Database from 'better-sqlite3';
import { createSqliteAdapter } from '../../../db/sqlite-adapter.js';
import { createCdpTraceEventsRouter } from '../cdp-trace-events.js';

const WORKSPACE_ID = 'test-workspace';

let rawDb: InstanceType<typeof Database>;

// ── Mock req/res helpers ─────────────────────────────────────────────────────

interface MockRes {
  _status: number;
  _body: unknown;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

function makeRes(): MockRes {
  const res: MockRes = { _status: 200, _body: undefined, status: vi.fn(), json: vi.fn() };
  res.status.mockImplementation((code: number) => { res._status = code; return res; });
  res.json.mockImplementation((body: unknown) => { res._body = body; return res; });
  return res;
}

function makeReq(query: Record<string, string> = {}): Request {
  return { query, params: {}, body: {}, headers: {} } as unknown as Request;
}

/**
 * Extract a route handler from an Express Router by method + path.
 */
function findHandler(
  router: ReturnType<typeof import('express').Router>,
  method: string,
  path: string,
): (req: Request, res: Response) => Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layers = (router as any).stack as Array<{
    route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: Array<{ handle: (...args: unknown[]) => unknown }>;
    };
  }>;
  for (const layer of layers) {
    if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      const handlers = layer.route.stack.map(s => s.handle);
      return async (req: Request, res: Response) => {
        for (const h of handlers) {
          let called = false;
          const next = () => { called = true; };
          await h(req, res, next);
          if (!called) return;
        }
      };
    }
  }
  throw new Error(`Handler not found: ${method.toUpperCase()} ${path}`);
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeAll(() => {
  rawDb = new Database(':memory:');

  rawDb.exec(`
    CREATE TABLE cdp_trace_events (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      ts            TEXT NOT NULL,
      action        TEXT NOT NULL,
      profile       TEXT,
      target_id     TEXT,
      owner         TEXT,
      url           TEXT,
      metadata_json TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_cdp_trace_workspace_ts
      ON cdp_trace_events (workspace_id, ts DESC);
    CREATE INDEX idx_cdp_trace_workspace_action
      ON cdp_trace_events (workspace_id, action, ts DESC);
  `);

  const past = new Date(Date.now() - 60_000).toISOString();
  const middle = new Date(Date.now() - 30_000).toISOString();
  const recent = new Date(Date.now() - 1_000).toISOString();

  const ins = rawDb.prepare(`
    INSERT INTO cdp_trace_events (id, workspace_id, ts, action, profile, owner)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  ins.run('id-1', WORKSPACE_ID, past,   'browser:open', 'Default',   null);
  ins.run('id-2', WORKSPACE_ID, middle, 'claim',        'Default',   'task-abc');
  ins.run('id-3', WORKSPACE_ID, recent, 'release',      'Profile 1', 'task-abc');

  // Row in a different workspace — must never surface in results
  ins.run('id-4', 'other-workspace', recent, 'claim', 'Default', null);
});

afterAll(() => {
  rawDb.close();
});

function makeRouter() {
  const adapter = createSqliteAdapter(rawDb, {});
  return createCdpTraceEventsRouter(adapter, WORKSPACE_ID);
}

// ── Envelope shape ────────────────────────────────────────────────────────────

describe('GET /api/cdp-trace-events', () => {
  it('returns correct envelope shape', async () => {
    const router = makeRouter();
    const handler = findHandler(router, 'get', '/api/cdp-trace-events');
    const req = makeReq();
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._status).toBe(200);
    const body = res._body as { data: unknown[]; count: number; limit: number };
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.count).toBe('number');
    expect(typeof body.limit).toBe('number');
  });

  it('count matches data array length', async () => {
    const router = makeRouter();
    const handler = findHandler(router, 'get', '/api/cdp-trace-events');
    const res = makeRes();
    await handler(makeReq(), res as unknown as Response);
    const body = res._body as { data: unknown[]; count: number };
    expect(body.count).toBe(body.data.length);
  });

  it('returns 3 fixture rows for the correct workspace', async () => {
    const router = makeRouter();
    const handler = findHandler(router, 'get', '/api/cdp-trace-events');
    const res = makeRes();
    await handler(makeReq(), res as unknown as Response);
    const body = res._body as { data: Array<{ id: string }>; count: number };
    expect(body.count).toBe(3);
    const ids = body.data.map(r => r.id);
    expect(ids).not.toContain('id-4');
  });

  it('respects limit param', async () => {
    const router = makeRouter();
    const handler = findHandler(router, 'get', '/api/cdp-trace-events');
    const res = makeRes();
    await handler(makeReq({ limit: '2' }), res as unknown as Response);
    const body = res._body as { data: unknown[]; limit: number };
    expect(body.data.length).toBe(2);
    expect(body.limit).toBe(2);
  });

  it('rows have expected fields', async () => {
    const router = makeRouter();
    const handler = findHandler(router, 'get', '/api/cdp-trace-events');
    const res = makeRes();
    await handler(makeReq({ action: 'claim' }), res as unknown as Response);
    const body = res._body as { data: Array<Record<string, unknown>> };
    const row = body.data[0];
    for (const field of ['id', 'workspace_id', 'ts', 'action', 'profile', 'target_id', 'owner', 'url', 'metadata_json', 'created_at']) {
      expect(row).toHaveProperty(field);
    }
  });
});

// ── action= filter ────────────────────────────────────────────────────────────

describe('action= filter', () => {
  it('returns only claim rows', async () => {
    const router = makeRouter();
    const handler = findHandler(router, 'get', '/api/cdp-trace-events');
    const res = makeRes();
    await handler(makeReq({ action: 'claim' }), res as unknown as Response);
    const body = res._body as { data: Array<{ action: string; id: string }>; count: number };
    expect(body.count).toBe(1);
    expect(body.data[0].action).toBe('claim');
    expect(body.data[0].id).toBe('id-2');
  });

  it('returns 0 rows for unknown action', async () => {
    const router = makeRouter();
    const handler = findHandler(router, 'get', '/api/cdp-trace-events');
    const res = makeRes();
    await handler(makeReq({ action: 'does-not-exist' }), res as unknown as Response);
    const body = res._body as { count: number };
    expect(body.count).toBe(0);
  });
});

// ── since= filter ─────────────────────────────────────────────────────────────

describe('since= filter', () => {
  it('returns 0 rows for a future timestamp', async () => {
    const router = makeRouter();
    const handler = findHandler(router, 'get', '/api/cdp-trace-events');
    const res = makeRes();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await handler(makeReq({ since: future }), res as unknown as Response);
    const body = res._body as { count: number };
    expect(body.count).toBe(0);
  });

  it('returns all rows for a far-past timestamp', async () => {
    const router = makeRouter();
    const handler = findHandler(router, 'get', '/api/cdp-trace-events');
    const res = makeRes();
    const past = new Date(0).toISOString();
    await handler(makeReq({ since: past }), res as unknown as Response);
    const body = res._body as { count: number };
    expect(body.count).toBe(3);
  });
});
