/**
 * Permission Requests Route Tests
 *
 * Cover the three approval modes (once / always / deny) and the listing
 * endpoint. Uses a hand-rolled in-memory DB stub instead of mockDb because
 * the permission flow needs real bidirectional state — a maybeSingle call
 * after an insert must observe the row that was just written.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createPermissionRequestsRouter } from '../routes/permission-requests.js';
import os from 'node:os';
import path from 'node:path';

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
 * Tiny in-memory DB stub matching the surface
 * createPermissionRequestsRouter touches.
 */
function buildDb(seed: {
  tasks: Array<Record<string, unknown>>;
  agents?: Array<Record<string, unknown>>;
  paths?: Array<Record<string, unknown>>;
}) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    agent_workforce_tasks: seed.tasks,
    agent_workforce_agents: seed.agents ?? [],
    agent_file_access_paths: seed.paths ?? [],
  };
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  function makeBuilder(table: string) {
    const filters: Array<{ col: string; val: unknown; op: 'eq' | 'in' }> = [];
    const apply = () => tables[table].filter((row) => {
      return filters.every((f) => {
        if (f.op === 'in') return Array.isArray(f.val) && (f.val as unknown[]).includes(row[f.col]);
        return row[f.col] === f.val;
      });
    });
    const builder: Record<string, unknown> = {};
    builder.select = (_cols?: string) => builder;
    builder.eq = (col: string, val: unknown) => { filters.push({ col, val, op: 'eq' }); return builder; };
    builder.in = (col: string, vals: unknown[]) => { filters.push({ col, val: vals, op: 'in' }); return builder; };
    builder.order = () => builder;
    builder.limit = () => builder;
    builder.single = () => Promise.resolve({ data: apply()[0] ?? null, error: null });
    builder.maybeSingle = () => Promise.resolve({ data: apply()[0] ?? null, error: null });
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: apply(), count: apply().length, error: null });
    builder.insert = (row: Record<string, unknown>) => {
      tables[table].push({ ...row });
      return {
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      };
    };
    builder.update = (patch: Record<string, unknown>) => {
      const updateBuilder = {
        eq: (col: string, val: unknown) => {
          for (const row of tables[table]) {
            if (row[col] === val) Object.assign(row, patch);
          }
          return {
            then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
          };
        },
      };
      return updateBuilder;
    };
    return builder;
  }

  return {
    db: {
      from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
      rpc: vi.fn().mockImplementation((name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        return Promise.resolve({ data: null, error: null });
      }),
    },
    tables,
    rpcCalls,
  };
}

const HOME = os.homedir();

const baselinePermissionRequest = {
  tool_name: 'local_write_file',
  attempted_path: path.join(HOME, '.ohwow', 'living-docs', 'diary', '2026-04-14.md'),
  suggested_exact: path.join(HOME, '.ohwow', 'living-docs', 'diary', '2026-04-14.md'),
  suggested_parent: path.join(HOME, '.ohwow', 'living-docs', 'diary'),
  guard_reason: 'Path is outside the allowed directories.',
  iteration: 3,
  timestamp: '2026-04-14T07:30:00.000Z',
};

function seedTask(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'task-paused',
    workspace_id: 'ws-1',
    agent_id: 'agent-diary',
    title: 'Write daily diary',
    description: null,
    input: '{"title":"Write daily diary"}',
    status: 'needs_approval',
    approval_reason: 'permission_denied',
    permission_request: JSON.stringify(baselinePermissionRequest),
    priority: 'normal',
    goal_id: null,
    created_at: '2026-04-14T07:30:01.000Z',
    updated_at: '2026-04-14T07:30:01.000Z',
    ...overrides,
  };
}

describe('permission-requests routes', () => {
  let env: ReturnType<typeof buildDb>;
  let router: ReturnType<typeof createPermissionRequestsRouter>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeEngine: any = { executeTask: vi.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    env = buildDb({
      tasks: [seedTask()],
      agents: [{ id: 'agent-diary', name: 'diary-writer', workspace_id: 'ws-1' }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router = createPermissionRequestsRouter(env.db as any, fakeEngine);
    fakeEngine.executeTask.mockClear();
  });

  it('GET /api/permission-requests returns paused tasks with the parsed payload', async () => {
    const handler = findHandler(router, 'get', '/api/permission-requests');
    const req = makeReq();
    const res = makeRes();
    await handler(req, res as unknown as Response);
    expect(res._status).toBe(200);
    const body = res._body as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].task_id).toBe('task-paused');
    expect(body.data[0].agent_name).toBe('diary-writer');
    const reqPayload = body.data[0].request as Record<string, unknown>;
    expect(reqPayload.tool_name).toBe('local_write_file');
    expect(reqPayload.suggested_parent).toContain('diary');
  });

  it('POST approve mode=once spawns a child task with permission_grants set', async () => {
    const handler = findHandler(router, 'post', '/api/permission-requests/:taskId/approve');
    const req = makeReq({ params: { taskId: 'task-paused' }, body: { mode: 'once', scope: 'parent' } });
    const res = makeRes();
    await handler(req, res as unknown as Response);
    expect(res._status).toBe(200);
    const body = res._body as { ok: boolean; child_task_id: string; granted_path: string };
    expect(body.ok).toBe(true);
    expect(body.granted_path).toContain('diary');

    const childTask = env.tables.agent_workforce_tasks.find((t) => t.id === body.child_task_id);
    expect(childTask).toBeDefined();
    expect(childTask!.status).toBe('pending');
    expect(childTask!.parent_task_id).toBe('task-paused');
    expect(childTask!.resumed_from_task_id).toBe('task-paused');
    const grants = JSON.parse(childTask!.permission_grants as string);
    expect(grants).toContain(baselinePermissionRequest.suggested_parent);

    // Original marked approved
    const original = env.tables.agent_workforce_tasks.find((t) => t.id === 'task-paused');
    expect(original!.status).toBe('approved');

    // No row in agent_file_access_paths
    expect(env.tables.agent_file_access_paths).toHaveLength(0);

    // Engine kicked off the resume
    expect(fakeEngine.executeTask).toHaveBeenCalledWith('agent-diary', body.child_task_id);
  });

  it('POST approve mode=always persists to agent_file_access_paths AND spawns a child', async () => {
    const handler = findHandler(router, 'post', '/api/permission-requests/:taskId/approve');
    const req = makeReq({ params: { taskId: 'task-paused' }, body: { mode: 'always', scope: 'parent' } });
    const res = makeRes();
    await handler(req, res as unknown as Response);
    expect(res._status).toBe(200);

    expect(env.tables.agent_file_access_paths).toHaveLength(1);
    const granted = env.tables.agent_file_access_paths[0];
    expect(granted.path).toBe(baselinePermissionRequest.suggested_parent);
    expect(granted.agent_id).toBe('agent-diary');

    const body = res._body as { child_task_id: string };
    const childTask = env.tables.agent_workforce_tasks.find((t) => t.id === body.child_task_id);
    expect(childTask!.permission_grants).toBeUndefined(); // not set on "always"
  });

  it('POST approve mode=deny terminates the task without spawning a child', async () => {
    const handler = findHandler(router, 'post', '/api/permission-requests/:taskId/approve');
    const req = makeReq({ params: { taskId: 'task-paused' }, body: { mode: 'deny' } });
    const res = makeRes();
    await handler(req, res as unknown as Response);
    expect(res._status).toBe(200);

    const original = env.tables.agent_workforce_tasks.find((t) => t.id === 'task-paused');
    expect(original!.status).toBe('failed');
    expect(original!.failure_category).toBe('permission_denied');

    // Only the original task — no child spawned
    expect(env.tables.agent_workforce_tasks).toHaveLength(1);
    expect(env.tables.agent_file_access_paths).toHaveLength(0);
    expect(fakeEngine.executeTask).not.toHaveBeenCalled();
  });

  it('POST approve scope=edit requires a path field and rejects blocked system dirs', async () => {
    const handler = findHandler(router, 'post', '/api/permission-requests/:taskId/approve');

    // Missing path
    const res1 = makeRes();
    await handler(
      makeReq({ params: { taskId: 'task-paused' }, body: { mode: 'once', scope: 'edit' } }),
      res1 as unknown as Response,
    );
    expect(res1._status).toBe(400);

    // Blocked path
    const res2 = makeRes();
    await handler(
      makeReq({ params: { taskId: 'task-paused' }, body: { mode: 'once', scope: 'edit', path: '/etc' } }),
      res2 as unknown as Response,
    );
    expect(res2._status).toBe(403);

    // Outside home
    const res3 = makeRes();
    await handler(
      makeReq({ params: { taskId: 'task-paused' }, body: { mode: 'once', scope: 'edit', path: '/tmp/anywhere' } }),
      res3 as unknown as Response,
    );
    expect(res3._status).toBe(403);
  });

  it('POST approve 409s when the task is no longer awaiting a permission decision', async () => {
    env.tables.agent_workforce_tasks[0].status = 'completed';
    const handler = findHandler(router, 'post', '/api/permission-requests/:taskId/approve');
    const res = makeRes();
    await handler(
      makeReq({ params: { taskId: 'task-paused' }, body: { mode: 'once' } }),
      res as unknown as Response,
    );
    expect(res._status).toBe(409);
  });

  it('POST approve 400s on an unknown mode', async () => {
    const handler = findHandler(router, 'post', '/api/permission-requests/:taskId/approve');
    const res = makeRes();
    await handler(
      makeReq({ params: { taskId: 'task-paused' }, body: { mode: 'sometime' } }),
      res as unknown as Response,
    );
    expect(res._status).toBe(400);
  });
});
