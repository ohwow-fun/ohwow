/**
 * Attribution route tests.
 *
 * Exercises the public `/api/attribution/hit` endpoint end-to-end
 * against an in-memory sqlite adapter (not a mock) so the dedup
 * window, redirect behavior, and kill-switch all interact with real
 * query chains.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Request, Response } from 'express';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import { createAttributionRouter, ATTRIBUTION_EVENT_SAFELIST } from '../routes/attribution.js';
import {
  _resetRuntimeConfigCacheForTests,
  _seedRuntimeConfigCacheForTests,
} from '../../self-bench/runtime-config.js';

interface RecordedRedirect {
  status: number;
  url: string;
}

function makeRes(): { res: Response; captured: RecordedRedirect[] } {
  const captured: RecordedRedirect[] = [];
  const res = {
    redirect: vi.fn((status: number | string, url?: string) => {
      if (typeof status === 'number' && typeof url === 'string') {
        captured.push({ status, url });
      } else if (typeof status === 'string') {
        captured.push({ status: 302, url: status });
      }
    }),
  } as unknown as Response;
  return { res, captured };
}

function makeReq(query: Record<string, string>, headers: Record<string, string> = {}): Request {
  return {
    query,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function getHandler(router: ReturnType<typeof createAttributionRouter>): (req: Request, res: Response) => Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (router as any).stack as Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: () => void) => Promise<void> }> };
  }>;
  for (const layer of stack) {
    if (layer.route?.path === '/api/attribution/hit' && layer.route.methods.get) {
      const [{ handle }] = layer.route.stack;
      return async (req, res) => {
        await handle(req, res, () => { /* noop */ });
      };
    }
  }
  throw new Error('handler not found');
}

describe('attribution route', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;
  let router: ReturnType<typeof createAttributionRouter>;
  let handler: (req: Request, res: Response) => Promise<void>;

  beforeEach(() => {
    _resetRuntimeConfigCacheForTests();
    rawDb = new Database(':memory:');
    rawDb.exec(`
      CREATE TABLE agent_workforce_contacts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT,
        outreach_token TEXT,
        never_sync INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE agent_workforce_contact_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        contact_id TEXT,
        kind TEXT,
        source TEXT,
        payload TEXT DEFAULT '{}',
        occurred_at TEXT,
        event_type TEXT,
        title TEXT,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    rawDb.prepare(
      `INSERT INTO agent_workforce_contacts (id, workspace_id, name, outreach_token) VALUES (?, ?, ?, ?)`,
    ).run('c1', 'ws1', 'Alice', 'tok-alice');

    adapter = createSqliteAdapter(rawDb);
    router = createAttributionRouter(adapter);
    handler = getHandler(router);
  });

  afterEach(() => {
    rawDb.close();
    _resetRuntimeConfigCacheForTests();
  });

  function countEvents(): number {
    return (rawDb.prepare(`SELECT COUNT(*) AS c FROM agent_workforce_contact_events`).get() as { c: number }).c;
  }

  it('records x:reached by default when the event arg is missing', async () => {
    const { res, captured } = makeRes();
    await handler(makeReq({ t: 'tok-alice' }), res);
    expect(captured).toEqual([{ status: 302, url: 'https://ohwow.fun/' }]);
    const rows = rawDb.prepare(`SELECT kind, contact_id, source FROM agent_workforce_contact_events`).all() as Array<{ kind: string; contact_id: string; source: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('x:reached');
    expect(rows[0].contact_id).toBe('c1');
    expect(rows[0].source).toBe('attribution');
  });

  it('accepts safelisted event kinds via ?e=', async () => {
    for (const kind of ATTRIBUTION_EVENT_SAFELIST) {
      rawDb.prepare(`DELETE FROM agent_workforce_contact_events`).run();
      const { res } = makeRes();
      await handler(makeReq({ t: 'tok-alice', e: kind }), res);
      const rows = rawDb.prepare(`SELECT kind FROM agent_workforce_contact_events`).all() as Array<{ kind: string }>;
      expect(rows[0].kind).toBe(kind);
    }
  });

  it('falls back to x:reached for unknown event arg', async () => {
    const { res } = makeRes();
    await handler(makeReq({ t: 'tok-alice', e: 'malicious:kind' }), res);
    const rows = rawDb.prepare(`SELECT kind FROM agent_workforce_contact_events`).all() as Array<{ kind: string }>;
    expect(rows[0].kind).toBe('x:reached');
  });

  it('dedups repeat hits for same (contact, kind) within 24h', async () => {
    const { res: res1 } = makeRes();
    await handler(makeReq({ t: 'tok-alice' }), res1);
    const { res: res2 } = makeRes();
    await handler(makeReq({ t: 'tok-alice' }), res2);
    expect(countEvents()).toBe(1);
  });

  it('allows a second hit with a different kind in the same window', async () => {
    const { res: res1 } = makeRes();
    await handler(makeReq({ t: 'tok-alice', e: 'x:reached' }), res1);
    const { res: res2 } = makeRes();
    await handler(makeReq({ t: 'tok-alice', e: 'demo:booked' }), res2);
    expect(countEvents()).toBe(2);
  });

  it('redirects without writing when the token does not match a contact', async () => {
    const { res, captured } = makeRes();
    await handler(makeReq({ t: 'nope' }), res);
    expect(captured).toEqual([{ status: 302, url: 'https://ohwow.fun/' }]);
    expect(countEvents()).toBe(0);
  });

  it('redirects without writing when the token is empty', async () => {
    const { res, captured } = makeRes();
    await handler(makeReq({}), res);
    expect(captured).toEqual([{ status: 302, url: 'https://ohwow.fun/' }]);
    expect(countEvents()).toBe(0);
  });

  it('respects attribution.tracking_enabled=false kill switch', async () => {
    _seedRuntimeConfigCacheForTests('attribution.tracking_enabled', false);
    const { res, captured } = makeRes();
    await handler(makeReq({ t: 'tok-alice' }), res);
    expect(captured).toEqual([{ status: 302, url: 'https://ohwow.fun/' }]);
    expect(countEvents()).toBe(0);
  });

  it('respects attribution.redirect_url override', async () => {
    _seedRuntimeConfigCacheForTests('attribution.redirect_url', 'https://campaign.example.com/thanks');
    const { res, captured } = makeRes();
    await handler(makeReq({ t: 'tok-alice' }), res);
    expect(captured[0].url).toBe('https://campaign.example.com/thanks');
  });
});
