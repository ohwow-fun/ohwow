import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createFindingsRouter } from '../routes/findings.js';

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

function makeReq(query: Record<string, string> = {}): Request {
  return {
    query,
    params: {},
    body: {},
    headers: {},
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
 * Minimal DB stub — findings-store's listFindings uses a chainable
 * .from().select().eq().order().limit() call, so that's all we need
 * to mock. Returns the input rows unchanged when any filter eq is
 * hit; the route test uses pre-filtered rows per case.
 */
function buildDb(rows: Array<Record<string, unknown>>) {
  function makeBuilder() {
    const filters: Array<{ col: string; val: unknown }> = [];
    let limitN: number | null = null;
    const apply = () => rows.filter((r) => filters.every((f) => r[f.col] === f.val));
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => { filters.push({ col, val }); return builder; };
    builder.order = () => builder;
    builder.limit = (n: number) => {
      limitN = n;
      const out = apply();
      return Promise.resolve({ data: limitN ? out.slice(0, limitN) : out, error: null });
    };
    return builder;
  }
  return { from: vi.fn().mockImplementation(() => makeBuilder()) };
}

const rows = [
  {
    id: 'f1', experiment_id: 'model-health', category: 'model_health', subject: 'qwen/qwen3.5-9b',
    hypothesis: 'h1', verdict: 'fail', summary: '0% tool-call rate',
    evidence: JSON.stringify({ samples: 12, rate: 0 }),
    intervention_applied: JSON.stringify({ description: 'demoted', details: {} }),
    ran_at: '2026-04-14T12:00:00Z', duration_ms: 42, status: 'active',
    superseded_by: null, created_at: '2026-04-14T12:00:00Z',
  },
  {
    id: 'f2', experiment_id: 'trigger-stability', category: 'trigger_stability', subject: null,
    hypothesis: 'h2', verdict: 'pass', summary: 'all triggers healthy',
    evidence: '{}', intervention_applied: null,
    ran_at: '2026-04-14T12:05:00Z', duration_ms: 7, status: 'active',
    superseded_by: null, created_at: '2026-04-14T12:05:00Z',
  },
  {
    id: 'f3', experiment_id: 'model-health', category: 'model_health', subject: null,
    hypothesis: 'h1', verdict: 'pass', summary: 'all models healthy',
    evidence: '{}', intervention_applied: null,
    ran_at: '2026-04-14T13:00:00Z', duration_ms: 5, status: 'active',
    superseded_by: null, created_at: '2026-04-14T13:00:00Z',
  },
];

describe('createFindingsRouter', () => {
  it('GET /api/findings returns active findings with default limit=50', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = createFindingsRouter(buildDb(rows) as any);
    const handler = findHandler(router, 'get', '/api/findings');
    const res = makeRes();
    await handler(makeReq(), res as unknown as Response);
    expect(res._status).toBe(200);
    const body = res._body as { data: unknown[]; count: number; limit: number };
    expect(body.count).toBe(3);
    expect(body.limit).toBe(50);
    expect(body.data).toHaveLength(3);
  });

  it('filters by experiment_id', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = createFindingsRouter(buildDb(rows) as any);
    const handler = findHandler(router, 'get', '/api/findings');
    const res = makeRes();
    await handler(makeReq({ experiment_id: 'trigger-stability' }), res as unknown as Response);
    const body = res._body as { data: Array<{ experimentId: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].experimentId).toBe('trigger-stability');
  });

  it('filters by category', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = createFindingsRouter(buildDb(rows) as any);
    const handler = findHandler(router, 'get', '/api/findings');
    const res = makeRes();
    await handler(makeReq({ category: 'model_health' }), res as unknown as Response);
    const body = res._body as { data: Array<{ category: string }> };
    expect(body.data).toHaveLength(2);
    expect(body.data.every((r) => r.category === 'model_health')).toBe(true);
  });

  it('filters by verdict=fail', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = createFindingsRouter(buildDb(rows) as any);
    const handler = findHandler(router, 'get', '/api/findings');
    const res = makeRes();
    await handler(makeReq({ verdict: 'fail' }), res as unknown as Response);
    const body = res._body as { data: Array<{ verdict: string; experimentId: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].verdict).toBe('fail');
    expect(body.data[0].experimentId).toBe('model-health');
  });

  it('ignores bogus category values instead of 400-ing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = createFindingsRouter(buildDb(rows) as any);
    const handler = findHandler(router, 'get', '/api/findings');
    const res = makeRes();
    await handler(makeReq({ category: 'not-a-real-category' }), res as unknown as Response);
    const body = res._body as { data: unknown[]; count: number };
    // Bogus category is silently dropped, returns all rows.
    expect(res._status).toBe(200);
    expect(body.count).toBe(3);
  });

  it('clamps limit to 500 even if a larger number is passed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = createFindingsRouter(buildDb(rows) as any);
    const handler = findHandler(router, 'get', '/api/findings');
    const res = makeRes();
    await handler(makeReq({ limit: '9999' }), res as unknown as Response);
    const body = res._body as { limit: number };
    expect(body.limit).toBe(500);
  });

  it('parses evidence and intervention JSON back to objects', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = createFindingsRouter(buildDb(rows) as any);
    const handler = findHandler(router, 'get', '/api/findings');
    const res = makeRes();
    await handler(makeReq({ experiment_id: 'model-health', verdict: 'fail' }), res as unknown as Response);
    const body = res._body as { data: Array<Record<string, unknown>> };
    expect(body.data[0].evidence).toEqual({ samples: 12, rate: 0 });
    expect((body.data[0].interventionApplied as { description: string }).description).toBe('demoted');
  });
});
