/**
 * Approvals Preview Route Tests
 *
 * Verifies GET /api/approvals/:id/preview returns the right verdict
 * for the shapes the queue actually contains: no deliverable,
 * pending_review send_dm in live mode, pending_review send_dm in
 * dry-run, missing action_spec, and already-resolved tasks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createApprovalsRouter } from '../routes/approvals.js';

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

function buildDb(seed: {
  tasks: Array<Record<string, unknown>>;
  deliverables: Array<Record<string, unknown>>;
  settings: Array<{ key: string; value: string }>;
}) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    agent_workforce_tasks: seed.tasks,
    agent_workforce_deliverables: seed.deliverables,
    runtime_settings: seed.settings as unknown as Array<Record<string, unknown>>,
    agent_workforce_activity: [],
  };

  function makeBuilder(table: string) {
    const filters: Array<{ col: string; val: unknown; op: 'eq' }> = [];
    let order: { col: string; ascending: boolean } | null = null;
    const apply = () => {
      let rows = tables[table].filter((row) =>
        filters.every((f) => row[f.col] === f.val),
      );
      if (order) {
        const col = order.col;
        const asc = order.ascending;
        rows = [...rows].sort((a, b) => {
          const av = a[col] as string;
          const bv = b[col] as string;
          if (av < bv) return asc ? -1 : 1;
          if (av > bv) return asc ? 1 : -1;
          return 0;
        });
      }
      return rows;
    };
    const builder: Record<string, unknown> = {};
    builder.select = (_cols?: string) => builder;
    builder.eq = (col: string, val: unknown) => { filters.push({ col, val, op: 'eq' }); return builder; };
    builder.order = (col: string, opts: { ascending: boolean }) => { order = { col, ascending: opts.ascending }; return builder; };
    builder.maybeSingle = () => Promise.resolve({ data: apply()[0] ?? null, error: null });
    builder.single = () => {
      const rows = apply();
      return Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'not found' } });
    };
    builder.then = (resolve: (v: unknown) => void) => resolve({ data: apply(), error: null });
    return builder;
  }

  return {
    db: {
      from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
    },
    tables,
  };
}

describe('GET /api/approvals/:id/preview', () => {
  let env: ReturnType<typeof buildDb>;
  let router: ReturnType<typeof createApprovalsRouter>;

  function seedAndRoute(seed: Parameters<typeof buildDb>[0]) {
    env = buildDb(seed);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router = createApprovalsRouter(env.db as any);
    return findHandler(router, 'get', '/api/approvals/:id/preview');
  }

  it('returns 404 when the task does not exist', async () => {
    const handler = seedAndRoute({ tasks: [], deliverables: [], settings: [] });
    const req = makeReq({ params: { id: 'missing' } });
    const res = makeRes();
    await handler(req, res as unknown as Response);
    expect(res._status).toBe(404);
  });

  it('verdict says "no deliverable" when the task has no attached deliverable', async () => {
    const handler = seedAndRoute({
      tasks: [{ id: 'task-1', workspace_id: 'ws-1', status: 'needs_approval' }],
      deliverables: [],
      settings: [{ key: 'deliverable_executor_live', value: 'true' }],
    });
    const req = makeReq({ params: { id: 'task-1' } });
    const res = makeRes();
    await handler(req, res as unknown as Response);
    expect(res._status).toBe(200);
    const body = res._body as { data: { verdict: string; deliverables: unknown[]; liveMode: boolean } };
    expect(body.data.verdict).toContain('No deliverable');
    expect(body.data.deliverables).toHaveLength(0);
    expect(body.data.liveMode).toBe(true);
  });

  it('verdict flags LIVE send for a pending_review send_dm deliverable when executor live=true', async () => {
    const content = JSON.stringify({ text: 'hey', handle: 'shannholmberg', action_spec: { type: 'send_dm' } });
    const handler = seedAndRoute({
      tasks: [{ id: 'task-dm', workspace_id: 'ws-1', status: 'needs_approval' }],
      deliverables: [{
        id: 'deliv-aa11bbcc-rest',
        workspace_id: 'ws-1',
        task_id: 'task-dm',
        deliverable_type: 'dm',
        provider: 'x',
        title: 'DM to @shannholmberg',
        content,
        status: 'pending_review',
      }],
      settings: [{ key: 'deliverable_executor_live', value: 'true' }],
    });
    const req = makeReq({ params: { id: 'task-dm' } });
    const res = makeRes();
    await handler(req, res as unknown as Response);
    expect(res._status).toBe(200);
    const body = res._body as { data: { verdict: string; liveMode: boolean; deliverables: Array<Record<string, unknown>> } };
    expect(body.data.liveMode).toBe(true);
    expect(body.data.verdict).toContain('send_dm');
    expect(body.data.verdict).toContain('@shannholmberg');
    expect(body.data.verdict).toContain('LIVE');
    const d = body.data.deliverables[0];
    expect(d.actionType).toBe('send_dm');
    expect(d.hasHandler).toBe(true);
    expect(d.contentPreview).toBe('hey');
    expect((d.target as { handle: string }).handle).toBe('shannholmberg');
  });

  it('verdict flags DRY-RUN when executor live=false', async () => {
    const content = JSON.stringify({ text: 'hey', handle: 'shannholmberg', action_spec: { type: 'send_dm' } });
    const handler = seedAndRoute({
      tasks: [{ id: 'task-dm', workspace_id: 'ws-1', status: 'needs_approval' }],
      deliverables: [{
        id: 'deliv-1', workspace_id: 'ws-1', task_id: 'task-dm',
        deliverable_type: 'dm', provider: 'x', content, status: 'pending_review',
      }],
      settings: [{ key: 'deliverable_executor_live', value: 'false' }],
    });
    const req = makeReq({ params: { id: 'task-dm' } });
    const res = makeRes();
    await handler(req, res as unknown as Response);
    const body = res._body as { data: { verdict: string; liveMode: boolean } };
    expect(body.data.liveMode).toBe(false);
    expect(body.data.verdict).toContain('DRY-RUN');
  });

  it('verdict flags missing action_spec for a deliverable with no inferrable type', async () => {
    const content = JSON.stringify({ text: 'diary entry' });
    const handler = seedAndRoute({
      tasks: [{ id: 'task-diary', workspace_id: 'ws-1', status: 'needs_approval' }],
      deliverables: [{
        id: 'deliv-diary', workspace_id: 'ws-1', task_id: 'task-diary',
        deliverable_type: 'doc', provider: null, content, status: 'pending_review',
      }],
      settings: [{ key: 'deliverable_executor_live', value: 'true' }],
    });
    const req = makeReq({ params: { id: 'task-diary' } });
    const res = makeRes();
    await handler(req, res as unknown as Response);
    const body = res._body as { data: { verdict: string } };
    expect(body.data.verdict).toContain('no action_spec');
  });

  it('verdict says "already resolved" when the task is not in needs_approval', async () => {
    const handler = seedAndRoute({
      tasks: [{ id: 'task-done', workspace_id: 'ws-1', status: 'approved' }],
      deliverables: [],
      settings: [{ key: 'deliverable_executor_live', value: 'true' }],
    });
    const req = makeReq({ params: { id: 'task-done' } });
    const res = makeRes();
    await handler(req, res as unknown as Response);
    const body = res._body as { data: { verdict: string } };
    expect(body.data.verdict).toContain('already resolved');
  });
});
