import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createContentQueueRouter } from '../routes/content-queue.js';

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
    query: {},
    params: {},
    body: {},
    headers: {},
    workspaceId: 'ws-test',
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
    route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: Array<{ handle: (...args: unknown[]) => unknown }>;
    };
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
 * Chainable query-builder stub: supports .select/.eq/.gte/.order/.limit
 * and returns a filtered subset of the configured rows per table.
 */
function buildDb(tables: Record<string, Array<Record<string, unknown>>>) {
  function makeBuilder(rows: Array<Record<string, unknown>>) {
    let filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let limitN: number | null = null;
    const apply = () => rows.filter((r) => filters.every((f) => f(r)));
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return builder;
    };
    builder.gte = (col: string, val: unknown) => {
      filters.push((r) => String(r[col]) >= String(val));
      return builder;
    };
    builder.order = () => builder;
    builder.limit = (n: number) => {
      limitN = n;
      const out = apply();
      filters = [];
      return Promise.resolve({ data: limitN ? out.slice(0, limitN) : out, error: null });
    };
    return builder;
  }
  return {
    from: (table: string) => makeBuilder(tables[table] ?? []),
  };
}

describe('content-queue route', () => {
  it('returns empty sections when no data exists', async () => {
    const db = buildDb({});
    const router = createContentQueueRouter(db as never);
    const handler = findHandler(router, 'get', '/api/content-queue');
    const res = makeRes();
    await handler(makeReq(), res as unknown as Response);
    expect(res._status).toBe(200);
    const body = res._body as { data: Record<string, unknown> };
    expect(body.data.pending).toEqual([]);
    expect(body.data.inflight).toEqual([]);
    expect(body.data.shipped).toEqual([]);
    expect(body.data.failures).toEqual([]);
    expect(body.data.automations).toEqual([]);
    expect(body.data.distiller).toEqual({
      pending_24h: 0,
      approved_24h: 0,
      rejected_24h: 0,
      total_24h: 0,
    });
  });

  it('returns pending drafts, filters by workspace, and tags distiller stats', async () => {
    const nowIso = new Date().toISOString();
    const db = buildDb({
      x_post_drafts: [
        {
          id: 'd1',
          workspace_id: 'ws-test',
          body: 'hello',
          source_finding_id: 'f1',
          status: 'pending',
          created_at: nowIso,
        },
        {
          id: 'd2',
          workspace_id: 'ws-test',
          body: 'world',
          source_finding_id: 'f2',
          status: 'approved',
          created_at: nowIso,
        },
        {
          id: 'd3',
          workspace_id: 'other',
          body: 'x',
          source_finding_id: null,
          status: 'pending',
          created_at: nowIso,
        },
      ],
    });
    const router = createContentQueueRouter(db as never);
    const handler = findHandler(router, 'get', '/api/content-queue');
    const res = makeRes();
    await handler(makeReq(), res as unknown as Response);
    const body = res._body as { data: { pending: Array<{ id: string }>; distiller: Record<string, number> } };
    expect(body.data.pending).toHaveLength(1);
    expect(body.data.pending[0].id).toBe('d1');
    expect(body.data.distiller.pending_24h).toBe(1);
    expect(body.data.distiller.approved_24h).toBe(1);
    expect(body.data.distiller.total_24h).toBe(2);
  });

  it('partitions content-dispatcher tasks by status, ignores non-content tasks', async () => {
    const nowIso = new Date().toISOString();
    const db = buildDb({
      agent_workforce_tasks: [
        {
          id: 't1',
          workspace_id: 'ws-test',
          agent_id: 'a1',
          title: 'Post one tweet today',
          status: 'running',
          metadata: JSON.stringify({ dispatcher: 'content_cadence', platform: 'x' }),
          created_at: nowIso,
          completed_at: null,
          error: null,
        },
        {
          id: 't2',
          workspace_id: 'ws-test',
          agent_id: 'a1',
          title: 'Post one threads post',
          status: 'failed',
          metadata: JSON.stringify({ dispatcher: 'content_cadence', platform: 'threads' }),
          created_at: nowIso,
          completed_at: nowIso,
          error: 'auth cookie expired',
        },
        {
          id: 't3',
          workspace_id: 'ws-test',
          agent_id: 'a2',
          title: 'Unrelated CRM task',
          status: 'pending',
          metadata: JSON.stringify({ dispatcher: 'crm_sync' }),
          created_at: nowIso,
          completed_at: null,
          error: null,
        },
      ],
    });
    const router = createContentQueueRouter(db as never);
    const handler = findHandler(router, 'get', '/api/content-queue');
    const res = makeRes();
    await handler(makeReq(), res as unknown as Response);
    const body = res._body as {
      data: {
        inflight: Array<{ id: string; platform: string | null }>;
        failures: Array<{ id: string; error: string | null }>;
      };
    };
    expect(body.data.inflight.map((t) => t.id)).toEqual(['t1']);
    expect(body.data.inflight[0].platform).toBe('x');
    expect(body.data.failures.map((t) => t.id)).toEqual(['t2']);
    expect(body.data.failures[0].error).toBe('auth cookie expired');
  });

  it('filters automations to the three content lanes', async () => {
    const db = buildDb({
      agent_workforce_workflows: [
        { id: 'w1', workspace_id: 'ws-test', name: 'ohwow:content-cadence', enabled: 1, fire_count: 47, last_fired_at: '2026-04-18T02:52:00Z', status: 'active' },
        { id: 'w2', workspace_id: 'ws-test', name: 'ohwow:x-draft-distiller', enabled: 1, fire_count: 17, last_fired_at: '2026-04-18T02:48:35Z', status: 'active' },
        { id: 'w3', workspace_id: 'ws-test', name: 'ohwow:x-humor', enabled: 0, fire_count: 3, last_fired_at: null, status: 'active' },
        { id: 'w4', workspace_id: 'ws-test', name: 'ohwow:x-intel-pipeline', enabled: 1, fire_count: 14, last_fired_at: null, status: 'active' },
      ],
    });
    const router = createContentQueueRouter(db as never);
    const handler = findHandler(router, 'get', '/api/content-queue');
    const res = makeRes();
    await handler(makeReq(), res as unknown as Response);
    const body = res._body as {
      data: { automations: Array<{ id: string; name: string; enabled: boolean }> };
    };
    expect(body.data.automations).toHaveLength(3);
    const humor = body.data.automations.find((a) => a.name === 'ohwow:x-humor');
    expect(humor?.enabled).toBe(false);
    expect(body.data.automations.some((a) => a.name === 'ohwow:x-intel-pipeline')).toBe(false);
  });

  it('tags shipped rows as reply when source starts with reply_to:', async () => {
    const db = buildDb({
      posted_log: [
        { id: 'p1', workspace_id: 'ws-test', platform: 'x', text_hash: 'h1', text_preview: 'hey', posted_at: new Date().toISOString(), source: null, task_id: null },
        { id: 'p2', workspace_id: 'ws-test', platform: 'threads', text_hash: 'h2', text_preview: 'reply', posted_at: new Date().toISOString(), source: 'reply_to:https://threads.net/foo', task_id: 't9' },
      ],
    });
    const router = createContentQueueRouter(db as never);
    const handler = findHandler(router, 'get', '/api/content-queue');
    const res = makeRes();
    await handler(makeReq(), res as unknown as Response);
    const body = res._body as {
      data: { shipped: Array<{ id: string; kind: string }> };
    };
    const byId = new Map(body.data.shipped.map((p) => [p.id, p.kind]));
    expect(byId.get('p1')).toBe('post');
    expect(byId.get('p2')).toBe('reply');
  });

  it('returns 400 when workspace is not resolved', async () => {
    const db = buildDb({});
    const router = createContentQueueRouter(db as never);
    const handler = findHandler(router, 'get', '/api/content-queue');
    const res = makeRes();
    await handler(makeReq({ workspaceId: undefined } as Partial<Request>), res as unknown as Response);
    expect(res._status).toBe(400);
  });
});
