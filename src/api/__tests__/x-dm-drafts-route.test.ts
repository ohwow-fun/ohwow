/**
 * X DM Drafts Route Tests
 *
 * Verifies that POST /api/x-dm-drafts stages a task + deliverable pair
 * in the shape the approvals flow expects, resolves the default "Voice"
 * agent when none is provided, and refuses contacts that lack an X
 * handle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createXDmDraftsRouter } from '../routes/x-dm-drafts.js';

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
  contacts: Array<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
}) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    agent_workforce_contacts: seed.contacts,
    agent_workforce_agents: seed.agents,
    agent_workforce_tasks: [],
    agent_workforce_deliverables: [],
  };

  function makeBuilder(table: string) {
    const filters: Array<{ col: string; val: unknown; op: 'eq' | 'is' }> = [];
    let limitN: number | null = null;
    const apply = () => {
      let rows = tables[table].filter((row) =>
        filters.every((f) => {
          if (f.op === 'is' && f.val === null) return row[f.col] == null;
          return row[f.col] === f.val;
        }),
      );
      if (limitN != null) rows = rows.slice(0, limitN);
      return rows;
    };
    const builder: Record<string, unknown> = {};
    builder.select = (_cols?: string) => builder;
    builder.eq = (col: string, val: unknown) => { filters.push({ col, val, op: 'eq' }); return builder; };
    builder.is = (col: string, val: unknown) => { filters.push({ col, val, op: 'is' }); return builder; };
    builder.limit = (n: number) => { limitN = n; return builder; };
    builder.maybeSingle = () => Promise.resolve({ data: apply()[0] ?? null, error: null });
    builder.insert = (row: Record<string, unknown>) => {
      tables[table].push({ ...row });
      return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) };
    };
    return builder;
  }

  return {
    db: {
      from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
    },
    tables,
  };
}

const xContact = {
  id: 'contact-shann',
  workspace_id: 'ws-1',
  name: 'Shann³',
  custom_fields: JSON.stringify({ x_handle: 'shannholmberg', x_intent: 'buyer_intent' }),
};

const voiceAgent = {
  id: 'agent-voice',
  workspace_id: 'ws-1',
  role: 'Public Communications',
  archived_at: null,
};

describe('POST /api/x-dm-drafts', () => {
  let env: ReturnType<typeof buildDb>;
  let router: ReturnType<typeof createXDmDraftsRouter>;

  beforeEach(() => {
    env = buildDb({ contacts: [{ ...xContact }], agents: [{ ...voiceAgent }] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router = createXDmDraftsRouter(env.db as any);
  });

  it('stages a needs_approval task + pending_review deliverable for a contact with x_handle', async () => {
    const handler = findHandler(router, 'post', '/api/x-dm-drafts');
    const req = makeReq({ body: { contact_id: 'contact-shann', body: 'saw your Zapier post, curious what you tried' } });
    const res = makeRes();
    await handler(req, res as unknown as Response);

    expect(res._status).toBe(201);
    const body = res._body as { data: { task_id: string; handle: string; status: string } };
    expect(body.data.handle).toBe('shannholmberg');
    expect(body.data.status).toBe('needs_approval');

    const task = env.tables.agent_workforce_tasks[0];
    expect(task.status).toBe('needs_approval');
    expect(task.agent_id).toBe('agent-voice');
    expect(task.output).toBe('saw your Zapier post, curious what you tried');
    expect(task.title).toBe('DM draft for @shannholmberg');
    const deferred = JSON.parse(task.deferred_action as string);
    expect(deferred.type).toBe('send_dm');
    expect(deferred.params.handle).toBe('shannholmberg');

    const deliv = env.tables.agent_workforce_deliverables[0];
    expect(deliv.status).toBe('pending_review');
    expect(deliv.task_id).toBe(body.data.task_id);
    expect(deliv.deliverable_type).toBe('dm');
    expect(deliv.provider).toBe('x');
    const content = JSON.parse(deliv.content as string);
    expect(content.action_spec.type).toBe('send_dm');
    expect(content.text).toBe('saw your Zapier post, curious what you tried');
    expect(content.handle).toBe('shannholmberg');
    expect(content.contact_id).toBe('contact-shann');
  });

  it('respects an explicit agent_id override', async () => {
    const handler = findHandler(router, 'post', '/api/x-dm-drafts');
    const req = makeReq({ body: { contact_id: 'contact-shann', body: 'hi', agent_id: 'agent-custom' } });
    const res = makeRes();
    await handler(req, res as unknown as Response);
    expect(res._status).toBe(201);
    const task = env.tables.agent_workforce_tasks[0];
    expect(task.agent_id).toBe('agent-custom');
  });

  it('returns 404 when the contact does not exist', async () => {
    const handler = findHandler(router, 'post', '/api/x-dm-drafts');
    const req = makeReq({ body: { contact_id: 'missing', body: 'hi' } });
    const res = makeRes();
    await handler(req, res as unknown as Response);
    expect(res._status).toBe(404);
  });

  it('returns 404 when the contact belongs to a different workspace', async () => {
    env.tables.agent_workforce_contacts[0].workspace_id = 'ws-other';
    const handler = findHandler(router, 'post', '/api/x-dm-drafts');
    const req = makeReq({ body: { contact_id: 'contact-shann', body: 'hi' } });
    const res = makeRes();
    await handler(req, res as unknown as Response);
    expect(res._status).toBe(404);
  });

  it('returns 422 when the contact has no x_handle', async () => {
    env.tables.agent_workforce_contacts[0].custom_fields = JSON.stringify({ x_intent: 'buyer_intent' });
    const handler = findHandler(router, 'post', '/api/x-dm-drafts');
    const req = makeReq({ body: { contact_id: 'contact-shann', body: 'hi' } });
    const res = makeRes();
    await handler(req, res as unknown as Response);
    expect(res._status).toBe(422);
  });

  it('returns 400 when body is missing or empty', async () => {
    const handler = findHandler(router, 'post', '/api/x-dm-drafts');
    for (const bad of [{}, { contact_id: 'contact-shann' }, { contact_id: 'contact-shann', body: '   ' }]) {
      const res = makeRes();
      await handler(makeReq({ body: bad }), res as unknown as Response);
      expect(res._status).toBe(400);
    }
  });

  it('strips a leading @ from x_handle so titles and payloads are canonical', async () => {
    env.tables.agent_workforce_contacts[0].custom_fields = JSON.stringify({ x_handle: '@shannholmberg' });
    const handler = findHandler(router, 'post', '/api/x-dm-drafts');
    const req = makeReq({ body: { contact_id: 'contact-shann', body: 'hi' } });
    const res = makeRes();
    await handler(req, res as unknown as Response);
    expect(res._status).toBe(201);
    const task = env.tables.agent_workforce_tasks[0];
    expect(task.title).toBe('DM draft for @shannholmberg');
    const deferred = JSON.parse(task.deferred_action as string);
    expect(deferred.params.handle).toBe('shannholmberg');
  });
});
