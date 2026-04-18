import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createAutomationsRouter } from '../routes/automations.js';

/**
 * POST /api/automations/:id/{enable,disable} are the cloud dashboard's
 * pause/resume entry points. Gap A (round 2b): before these existed,
 * the UI wrote to Supabase `agent_workforce_workflows`, which the
 * runtime scheduler never reads — pausing from the UI did nothing.
 * The route must now flip `local_triggers.enabled`, notify the
 * scheduler via onScheduleChange, and return a flat { ok, automation }
 * envelope the proxy can pass straight back to the browser.
 */

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

function baseTriggerRow(id: string, enabled: 1 | 0) {
  return {
    id,
    name: 'ohwow:x-humor',
    description: '',
    source: 'ghl',
    event_type: 'schedule',
    conditions: '{}',
    action_type: 'run_agent',
    action_config: '{}',
    actions: '[]',
    enabled,
    cooldown_seconds: 60,
    last_fired_at: null,
    fire_count: 0,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    webhook_token: null,
    trigger_type: 'schedule',
    trigger_config: '{}',
    definition: JSON.stringify({ steps: [] }),
    variables: null,
    node_positions: null,
    sample_payload: null,
    sample_fields: null,
    status: 'active',
  };
}

/**
 * Minimal db mock: the AutomationService.update path reads the row,
 * writes the new `enabled` flag, then reads it back. This stub keeps a
 * tiny record in memory and returns it via `.single()`.
 */
function buildDb(initial: ReturnType<typeof baseTriggerRow> | null) {
  let row = initial;
  const chain: Record<string, unknown> = {};
  const ret = () => ({ data: row, error: null });
  const arrRet = () => ({ data: row ? [row] : [], error: null });

  for (const m of ['select', 'eq', 'order', 'limit', 'in', 'is', 'gte', 'lte', 'neq']) {
    (chain as Record<string, unknown>)[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockImplementation(() => Promise.resolve(ret()));
  chain.maybeSingle = vi.fn().mockImplementation(() => Promise.resolve(ret()));
  chain.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) => resolve(arrRet()));
  chain.update = vi.fn().mockImplementation((patch: Record<string, unknown>) => {
    if (row) {
      row = { ...row, ...patch } as typeof row;
      if ('enabled' in patch) {
        row = { ...row, enabled: patch.enabled ? 1 : 0 } as typeof row;
      }
    }
    return chain;
  });
  chain.insert = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue(ret()),
    }),
  });

  return {
    from: vi.fn().mockReturnValue(chain),
  };
}

describe('POST /api/automations/:id/{enable,disable}', () => {
  it('flips local_triggers.enabled and notifies the scheduler on enable', async () => {
    const db = buildDb(baseTriggerRow('auto-1', 0));
    const onScheduleChange = vi.fn();
    const router = createAutomationsRouter(db as never, 'ws-test', undefined, onScheduleChange);
    const handler = findHandler(router, 'post', '/api/automations/:id/enable');

    const res = makeRes();
    await handler(
      { params: { id: 'auto-1' }, body: {}, query: {}, workspaceId: 'ws-test' } as unknown as Request,
      res as unknown as Response,
    );

    expect(res._status).toBe(200);
    const body = res._body as { ok: boolean; automation: { enabled: boolean } };
    expect(body.ok).toBe(true);
    expect(body.automation.enabled).toBe(true);
    expect(onScheduleChange).toHaveBeenCalledTimes(1);
  });

  it('flips enabled off and returns a flat ok envelope on disable', async () => {
    const db = buildDb(baseTriggerRow('auto-1', 1));
    const onScheduleChange = vi.fn();
    const router = createAutomationsRouter(db as never, 'ws-test', undefined, onScheduleChange);
    const handler = findHandler(router, 'post', '/api/automations/:id/disable');

    const res = makeRes();
    await handler(
      { params: { id: 'auto-1' }, body: {}, query: {}, workspaceId: 'ws-test' } as unknown as Request,
      res as unknown as Response,
    );

    expect(res._status).toBe(200);
    const body = res._body as { ok: boolean; automation: { enabled: boolean } };
    expect(body.ok).toBe(true);
    expect(body.automation.enabled).toBe(false);
    expect(onScheduleChange).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the automation id is unknown', async () => {
    const db = buildDb(null);
    const router = createAutomationsRouter(db as never, 'ws-test');
    const handler = findHandler(router, 'post', '/api/automations/:id/enable');

    const res = makeRes();
    await handler(
      { params: { id: 'missing' }, body: {}, query: {}, workspaceId: 'ws-test' } as unknown as Request,
      res as unknown as Response,
    );

    expect(res._status).toBe(404);
    const body = res._body as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});
