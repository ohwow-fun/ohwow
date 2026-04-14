import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createFailingTriggersRouter } from '../routes/failing-triggers.js';

interface MockRes {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  _status: number;
  _body: unknown;
}

function makeRes(): MockRes {
  const res: MockRes = { _status: 200, _body: undefined, status: vi.fn(), json: vi.fn() };
  res.status.mockImplementation((code: number) => { res._status = code; return res; });
  res.json.mockImplementation((body: unknown) => { res._body = body; return res; });
  return res;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    workspaceId: 'ws-1',
    params: {},
    query: {},
    body: {},
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function findHandler(
  router: ReturnType<typeof import('express').Router>,
  method: string,
  routePath: string,
): (req: Request, res: Response) => Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layers = (router as any).stack as Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> };
  }>;
  for (const layer of layers) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method.toLowerCase()]) {
      const handlers = layer.route.stack.map((s) => s.handle);
      return async (req: Request, res: Response) => {
        for (const handler of handlers) {
          let nexted = false;
          await handler(req, res, () => { nexted = true; });
          if (!nexted) return;
        }
      };
    }
  }
  throw new Error(`Handler not found: ${method.toUpperCase()} ${routePath}`);
}

/**
 * Minimal local_triggers stub that respects .gte() + .order() + workspace-free scoping.
 */
function buildDb(rows: Array<Record<string, unknown>>) {
  const state = [...rows];
  const chain = {
    select: () => chain,
    gte: (col: string, val: number) => {
      const filtered = state.filter((r) => ((r[col] as number | null) ?? 0) >= val);
      return {
        order: (orderCol: string, opts?: { ascending?: boolean }) => {
          const sorted = [...filtered].sort((a, b) => {
            const av = (a[orderCol] as number | null) ?? 0;
            const bv = (b[orderCol] as number | null) ?? 0;
            return opts?.ascending ? av - bv : bv - av;
          });
          return Promise.resolve({ data: sorted, error: null });
        },
      };
    },
  };
  return {
    from: vi.fn().mockReturnValue(chain),
  };
}

describe('createFailingTriggersRouter', () => {
  const seedRows = () => [
    { id: 't-healthy', name: 'healthy-trigger', consecutive_failures: 0, last_succeeded_at: '2026-04-14T06:00:00Z', last_fired_at: '2026-04-14T06:00:00Z', trigger_type: 'schedule', enabled: 1, last_error: null },
    { id: 't-shaky', name: 'shaky-trigger', consecutive_failures: 2, last_succeeded_at: '2026-04-10T06:00:00Z', last_fired_at: '2026-04-14T06:00:00Z', trigger_type: 'schedule', enabled: 1, last_error: 'some error' },
    { id: 't-stuck-3', name: 'stuck-3', consecutive_failures: 3, last_succeeded_at: null, last_fired_at: '2026-04-14T06:00:00Z', trigger_type: 'schedule', enabled: 1, last_error: 'hallucination gate' },
    { id: 't-stuck-7', name: 'stuck-7', consecutive_failures: 7, last_succeeded_at: '2026-03-20T06:00:00Z', last_fired_at: '2026-04-14T06:00:00Z', trigger_type: 'webhook', enabled: 1, last_error: 'timeout' },
  ];

  it('returns triggers at or above the default threshold, sorted worst-first', async () => {
    const db = buildDb(seedRows());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = createFailingTriggersRouter(db as any);
    const handler = findHandler(router, 'get', '/api/failing-triggers');
    const res = makeRes();
    await handler(makeReq(), res as unknown as Response);
    expect(res._status).toBe(200);
    const body = res._body as { data: Array<Record<string, unknown>>; threshold: number };
    expect(body.threshold).toBe(3);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe('t-stuck-7');
    expect(body.data[0].consecutive_failures).toBe(7);
    expect(body.data[1].id).toBe('t-stuck-3');
  });

  it('respects ?threshold=1 to include every failing trigger', async () => {
    const db = buildDb(seedRows());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = createFailingTriggersRouter(db as any);
    const handler = findHandler(router, 'get', '/api/failing-triggers');
    const res = makeRes();
    await handler(makeReq({ query: { threshold: '1' } }), res as unknown as Response);
    expect(res._status).toBe(200);
    const body = res._body as { data: Array<Record<string, unknown>>; threshold: number };
    expect(body.threshold).toBe(1);
    expect(body.data).toHaveLength(3);
    expect(body.data.map((d) => d.id)).toEqual(['t-stuck-7', 't-stuck-3', 't-shaky']);
  });

  it('clamps threshold to >=1 when given a silly value', async () => {
    const db = buildDb(seedRows());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = createFailingTriggersRouter(db as any);
    const handler = findHandler(router, 'get', '/api/failing-triggers');
    const res = makeRes();
    await handler(makeReq({ query: { threshold: '0' } }), res as unknown as Response);
    expect((res._body as { threshold: number }).threshold).toBe(1);
  });

  it('maps enabled=1 to boolean true on output', async () => {
    const db = buildDb([
      { id: 't1', name: 'a', consecutive_failures: 5, last_succeeded_at: null, last_fired_at: null, trigger_type: 'schedule', enabled: 1, last_error: null },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = createFailingTriggersRouter(db as any);
    const handler = findHandler(router, 'get', '/api/failing-triggers');
    const res = makeRes();
    await handler(makeReq(), res as unknown as Response);
    const body = res._body as { data: Array<{ enabled: boolean }> };
    expect(body.data[0].enabled).toBe(true);
  });

  it('returns empty array when no triggers are stuck', async () => {
    const db = buildDb([
      { id: 't1', name: 'all-good', consecutive_failures: 0, last_succeeded_at: '2026-04-14T00:00:00Z', last_fired_at: '2026-04-14T00:00:00Z', trigger_type: 'schedule', enabled: 1, last_error: null },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = createFailingTriggersRouter(db as any);
    const handler = findHandler(router, 'get', '/api/failing-triggers');
    const res = makeRes();
    await handler(makeReq(), res as unknown as Response);
    const body = res._body as { data: unknown[] };
    expect(body.data).toEqual([]);
  });
});
