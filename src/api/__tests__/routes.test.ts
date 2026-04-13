/**
 * API Route Tests
 * Tests the 5 most important route groups: tasks, agents, orchestrator sessions,
 * contacts, and settings.
 *
 * Uses direct handler invocation with mocked req/res/db (no supertest).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createTasksRouter } from '../routes/tasks.js';
import { createAgentsRouter } from '../routes/agents.js';
import { createOrchestratorRouter } from '../routes/orchestrator.js';
import { createContactsRouter } from '../routes/contacts.js';
import { createSettingsRouter } from '../routes/settings.js';
import { mockDb } from '../../__tests__/helpers/mock-db.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

/* ── Test helpers ────────────────────────────────────────────────── */

interface MockRes {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  _status: number;
  _body: unknown;
}

function makeRes(): MockRes {
  const res: MockRes = {
    _status: 200,
    _body: undefined,
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockImplementation((code: number) => {
    res._status = code;
    return res;
  });
  res.json.mockImplementation((body: unknown) => {
    res._body = body;
    return res;
  });
  return res;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    workspaceId: 'ws-test',
    userId: 'user-test',
    params: {},
    query: {},
    body: {},
    headers: {},
    ...overrides,
  } as unknown as Request;
}

/**
 * Extract a route handler from an Express Router by method + path.
 * Express stores layers on router.stack; each layer has a route with methods and stack of handlers.
 */
function findHandler(
  router: ReturnType<typeof import('express').Router>,
  method: string,
  path: string,
): (req: Request, res: Response) => Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layers = (router as any).stack as Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> };
  }>;

  for (const layer of layers) {
    if (
      layer.route &&
      layer.route.path === path &&
      layer.route.methods[method.toLowerCase()]
    ) {
      const handlers = layer.route.stack.map(
        (s: { handle: (...args: unknown[]) => unknown }) => s.handle,
      );
      // Chain all middleware + handler together
      return async (req: Request, res: Response) => {
        for (const handler of handlers) {
          let called = false;
          const next = () => { called = true; };
          await handler(req, res, next);
          if (!called) return; // middleware short-circuited (e.g. validation error)
        }
      };
    }
  }
  throw new Error(`Handler not found: ${method.toUpperCase()} ${path}`);
}

/* ── Tasks Routes ────────────────────────────────────────────────── */

describe('Tasks Routes', () => {
  let db: ReturnType<typeof mockDb>;
  let router: ReturnType<typeof import('express').Router>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = mockDb();
    router = createTasksRouter(db as unknown as DatabaseAdapter, null);
  });

  it('GET /api/tasks returns a list of tasks', async () => {
    const tasks = [
      { id: 'task-1', title: 'Do something', status: 'pending' },
      { id: 'task-2', title: 'Do another thing', status: 'completed' },
    ];
    db = mockDb({ agent_workforce_tasks: { data: tasks } });
    router = createTasksRouter(db as unknown as DatabaseAdapter, null);

    const handler = findHandler(router, 'get', '/api/tasks');
    const req = makeReq({ query: {} });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._body).toEqual({ data: tasks });
    expect(res.status).not.toHaveBeenCalled(); // 200 is implicit
  });

  it('GET /api/tasks/:id returns a single task', async () => {
    const task = { id: 'task-1', title: 'Do something', status: 'pending' };
    db = mockDb({ agent_workforce_tasks: { data: task } });
    router = createTasksRouter(db as unknown as DatabaseAdapter, null);

    const handler = findHandler(router, 'get', '/api/tasks/:id');
    const req = makeReq({ params: { id: 'task-1' } as Record<string, string> });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._body).toEqual({ data: task });
  });

  it('GET /api/tasks/:id returns 404 when task not found', async () => {
    db = mockDb({ agent_workforce_tasks: { data: null } });
    router = createTasksRouter(db as unknown as DatabaseAdapter, null);

    const handler = findHandler(router, 'get', '/api/tasks/:id');
    const req = makeReq({ params: { id: 'nonexistent' } as Record<string, string> });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Task not found' });
  });

  it('POST /api/tasks returns 400 when agentId or title missing', async () => {
    const handler = findHandler(router, 'post', '/api/tasks');
    const req = makeReq({ body: { title: 'Only title, no agentId' } });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'agentId and title are required' });
  });
});

/* ── Agents Routes ───────────────────────────────────────────────── */

describe('Agents Routes', () => {
  let db: ReturnType<typeof mockDb>;
  let router: ReturnType<typeof import('express').Router>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = mockDb();
    router = createAgentsRouter(db as unknown as DatabaseAdapter);
  });

  it('GET /api/agents returns a list of agents', async () => {
    const agents = [
      { id: 'agent-1', name: 'Writer', role: 'copywriter' },
      { id: 'agent-2', name: 'Coder', role: 'developer' },
    ];
    db = mockDb({ agent_workforce_agents: { data: agents } });
    router = createAgentsRouter(db as unknown as DatabaseAdapter);

    const handler = findHandler(router, 'get', '/api/agents');
    const req = makeReq();
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._body).toEqual({ data: agents });
  });

  it('GET /api/agents/:id returns a single agent', async () => {
    const agent = { id: 'agent-1', name: 'Writer', role: 'copywriter' };
    db = mockDb({ agent_workforce_agents: { data: agent } });
    router = createAgentsRouter(db as unknown as DatabaseAdapter);

    const handler = findHandler(router, 'get', '/api/agents/:id');
    const req = makeReq({ params: { id: 'agent-1' } as Record<string, string> });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._body).toEqual({ data: agent });
  });

  it('GET /api/agents/:id returns 404 when agent not found', async () => {
    db = mockDb({ agent_workforce_agents: { data: null } });
    router = createAgentsRouter(db as unknown as DatabaseAdapter);

    const handler = findHandler(router, 'get', '/api/agents/:id');
    const req = makeReq({ params: { id: 'ghost' } as Record<string, string> });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Agent not found' });
  });

  it('POST /api/agents returns 400 when required fields missing', async () => {
    const handler = findHandler(router, 'post', '/api/agents');
    const req = makeReq({ body: { name: 'Incomplete' } });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({
      error: 'Validation failed',
      details: [
        'system_prompt: Invalid input: expected string, received undefined',
      ],
    });
  });

  it('PATCH /api/agents/:id returns 400 when no valid fields provided', async () => {
    const handler = findHandler(router, 'patch', '/api/agents/:id');
    const req = makeReq({
      params: { id: 'agent-1' } as Record<string, string>,
      body: { bogus_field: 'nope' },
    });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'No valid fields to update' });
  });
});

/* ── Orchestrator Session Routes ─────────────────────────────────── */

describe('Orchestrator Routes', () => {
  let db: ReturnType<typeof mockDb>;
  let orchestrator: Record<string, unknown>;
  let router: ReturnType<typeof import('express').Router>;

  function makeOrchestrator(dbInstance: ReturnType<typeof mockDb>) {
    return {
      db: dbInstance,
      workspaceId: 'ws-test',
      setOrchestratorModel: vi.fn(),
      setModelSource: vi.fn(),
      chat: vi.fn(),
      setAnthropicApiKey: vi.fn(),
      resolvePermission: vi.fn(),
      resolveCostApproval: vi.fn(),
      setSkipMediaCostConfirmation: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    db = mockDb();
    orchestrator = makeOrchestrator(db);
    // The orchestrator router accesses orchestrator.db internally for session CRUD
    router = createOrchestratorRouter(orchestrator as never);
  });

  it('GET /api/orchestrator/sessions returns a list of sessions', async () => {
    const sessions = [
      { id: 's-1', title: 'Chat 1', messages: '[]', message_count: 3, device_name: null, target_type: 'orchestrator', target_id: null, created_at: '2026-01-01', updated_at: '2026-01-01' },
    ];
    db = mockDb({ orchestrator_chat_sessions: { data: sessions } });
    orchestrator = makeOrchestrator(db);
    router = createOrchestratorRouter(orchestrator as never);

    const handler = findHandler(router, 'get', '/api/orchestrator/sessions');
    const req = makeReq();
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._body).toHaveProperty('sessions');
    const result = res._body as { sessions: Array<{ id: string; title: string; message_count: number }> };
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe('s-1');
    expect(result.sessions[0].message_count).toBe(3);
  });

  it('GET /api/orchestrator/sessions/:id returns 404 when not found', async () => {
    db = mockDb({ orchestrator_chat_sessions: { data: null } });
    orchestrator = makeOrchestrator(db);
    router = createOrchestratorRouter(orchestrator as never);

    const handler = findHandler(router, 'get', '/api/orchestrator/sessions/:id');
    const req = makeReq({ params: { id: 'nonexistent' } as Record<string, string> });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Session not found' });
  });

  it('POST /api/chat returns 400 when message is missing', async () => {
    const handler = findHandler(router, 'post', '/api/chat');
    const req = makeReq({ body: {} });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Message is required' });
  });

  it('PATCH /api/orchestrator/sessions/:id/rename returns 400 with empty title', async () => {
    const handler = findHandler(router, 'patch', '/api/orchestrator/sessions/:id/rename');
    const req = makeReq({
      params: { id: 's-1' } as Record<string, string>,
      body: { title: '' },
    });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'title is required' });
  });
});

/* ── Contacts Routes ─────────────────────────────────────────────── */

describe('Contacts Routes', () => {
  let db: ReturnType<typeof mockDb>;
  let eventBus: { emit: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  let router: ReturnType<typeof import('express').Router>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = mockDb();
    eventBus = { emit: vi.fn(), on: vi.fn() };
    router = createContactsRouter(db as unknown as DatabaseAdapter, eventBus as never);
  });

  it('GET /api/contacts returns a list of contacts', async () => {
    const contacts = [
      { id: 'c-1', name: 'Alice', email: 'alice@example.com' },
      { id: 'c-2', name: 'Bob', email: 'bob@example.com' },
    ];
    db = mockDb({ agent_workforce_contacts: { data: contacts } });
    router = createContactsRouter(db as unknown as DatabaseAdapter, eventBus as never);

    const handler = findHandler(router, 'get', '/api/contacts');
    const req = makeReq();
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._body).toEqual({ data: contacts });
  });

  it('POST /api/contacts returns 400 when name is missing', async () => {
    const handler = findHandler(router, 'post', '/api/contacts');
    const req = makeReq({ body: { email: 'no-name@example.com' } });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'name is required' });
  });

  it('GET /api/contacts/:id/timeline returns timeline events', async () => {
    const events = [
      { id: 'ev-1', contact_id: 'c-1', event_type: 'note', content: 'Called' },
    ];
    db = mockDb({ agent_workforce_contact_events: { data: events } });
    router = createContactsRouter(db as unknown as DatabaseAdapter, eventBus as never);

    const handler = findHandler(router, 'get', '/api/contacts/:id/timeline');
    const req = makeReq({ params: { id: 'c-1' } as Record<string, string> });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._body).toEqual({ data: events });
  });
});

/* ── Settings Routes ─────────────────────────────────────────────── */

describe('Settings Routes', () => {
  let db: ReturnType<typeof mockDb>;
  let router: ReturnType<typeof import('express').Router>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = mockDb();
    router = createSettingsRouter(db as unknown as DatabaseAdapter);
  });

  it('GET /api/settings/:key returns a setting value', async () => {
    db = mockDb({ runtime_settings: { data: { key: 'ollama_model', value: 'llama3.1' } } });
    router = createSettingsRouter(db as unknown as DatabaseAdapter);

    const handler = findHandler(router, 'get', '/api/settings/:key');
    const req = makeReq({ params: { key: 'ollama_model' } as Record<string, string> });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._body).toEqual({ data: { key: 'ollama_model', value: 'llama3.1' } });
  });

  it('GET /api/settings/:key masks sensitive values', async () => {
    db = mockDb({ runtime_settings: { data: { key: 'anthropic_api_key', value: 'sk-ant-abcdef123456' } } });
    router = createSettingsRouter(db as unknown as DatabaseAdapter);

    const handler = findHandler(router, 'get', '/api/settings/:key');
    const req = makeReq({ params: { key: 'anthropic_api_key' } as Record<string, string> });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    const body = res._body as { data: { key: string; value: string } };
    expect(body.data.value).toBe('****3456');
    expect(body.data.value).not.toContain('sk-ant');
  });

  it('GET /api/settings/:key returns 400 for unknown keys', async () => {
    const handler = findHandler(router, 'get', '/api/settings/:key');
    const req = makeReq({ params: { key: 'not_a_real_setting' } as Record<string, string> });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Unknown setting key' });
  });

  it('GET /api/settings/:key returns null when setting not set', async () => {
    db = mockDb({ runtime_settings: { data: null } });
    router = createSettingsRouter(db as unknown as DatabaseAdapter);

    const handler = findHandler(router, 'get', '/api/settings/:key');
    const req = makeReq({ params: { key: 'tunnel_url' } as Record<string, string> });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._body).toEqual({ data: null });
  });

  it('PUT /api/settings/:key returns 400 when value is missing', async () => {
    const handler = findHandler(router, 'put', '/api/settings/:key');
    const req = makeReq({
      params: { key: 'ollama_model' } as Record<string, string>,
      body: {},
    });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'value is required' });
  });

  it('PUT /api/settings/:key returns 400 for unknown keys', async () => {
    const handler = findHandler(router, 'put', '/api/settings/:key');
    const req = makeReq({
      params: { key: 'hacker_key' } as Record<string, string>,
      body: { value: 'evil' },
    });
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Unknown setting key' });
  });
});
