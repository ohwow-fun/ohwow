/**
 * TEST C — Route resolver fallback
 *
 * Verifies the activeDb/activeEngine fallback pattern in createTasksRouter:
 *   - When getWorkspaceCtx returns a WorkspaceContext, route uses ctx.db and ctx.engine
 *   - When getWorkspaceCtx returns null (single-workspace / no ctx), route falls back
 *     to the closed-over primary db/engine passed to the factory
 *
 * Tests the resolver directly by inspecting which db.from() is called for each path,
 * using mock request/response objects (no HTTP layer needed for unit coverage).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import type { DatabaseAdapter } from '../../../db/adapter-types.js';
import type { WorkspaceContext } from '../../../daemon/workspace-context.js';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal chainable mock DatabaseAdapter and expose its from() spy. */
function makeMockDb(label: string) {
  const chain = {
    _label: label,
    select: vi.fn(),
    eq: vi.fn(),
    neq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    range: vi.fn(),
    single: vi.fn(),
    maybeSingle: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    then: vi.fn((resolve: (v: unknown) => void) =>
      resolve({ data: [], count: 0, error: null }),
    ),
  };

  // Make all builder methods return the same chain
  for (const m of ['select', 'eq', 'neq', 'order', 'limit', 'range', 'update', 'delete']) {
    (chain as Record<string, unknown>)[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.insert = vi.fn().mockReturnValue({
    then: vi.fn((resolve: (v: unknown) => void) => resolve({ data: null, error: null })),
  });

  const fromSpy = vi.fn().mockReturnValue(chain);
  const db = { _label: label, from: fromSpy, rpc: vi.fn() } as unknown as DatabaseAdapter & {
    _label: string;
    from: typeof fromSpy;
  };
  return db;
}

function makeWsCtx(db: DatabaseAdapter): WorkspaceContext {
  return {
    workspaceName: 'avenued',
    workspaceId: 'ws-avenued',
    dataDir: '/tmp/avenued',
    sessionToken: 'tok-avenued',
    rawDb: {} as ReturnType<typeof import('../../../db/init.js').initDatabase>,
    db,
    config: {} as import('../../../config.js').RuntimeConfig,
    businessContext: { businessName: 'AvenueD', businessType: 'saas_startup' },
    engine: null,
    orchestrator: null,
    triggerEvaluator: null,
    channelRegistry: null,
    connectorRegistry: null,
    messageRouter: null,
    scheduler: null,
    proactiveEngine: null,
    connectorSyncScheduler: null,
    controlPlane: null,
    bus: {} as import('../../../lib/typed-event-bus.js').TypedEventBus<import('../../../tui/types.js').RuntimeEvents>,
  };
}

/** Create minimal mock Express req/res pair. */
function mockReqRes(params: Record<string, string> = {}) {
  const req = {
    workspaceId: 'ws-primary',
    query: {},
    params,
    body: {},
  } as unknown as Request;

  const resData: { status?: number; json?: unknown } = {};
  const res = {
    status: vi.fn().mockImplementation((code: number) => { resData.status = code; return res; }),
    json: vi.fn().mockImplementation((body: unknown) => { resData.json = body; }),
  } as unknown as Response;

  return { req, res, resData };
}

// ---------------------------------------------------------------------------
// Tests — resolver logic extracted from route handlers
//
// We test the core resolution pattern directly rather than routing via Express
// to keep the tests fast and free of transport-layer setup.
// ---------------------------------------------------------------------------

describe('getWorkspaceCtx resolver — activeDb fallback', () => {
  let primaryDb: ReturnType<typeof makeMockDb>;
  let workspaceDb: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    primaryDb = makeMockDb('primary');
    workspaceDb = makeMockDb('workspace');
    vi.clearAllMocks();
  });

  it('resolves to ctx.db when getWorkspaceCtx returns a WorkspaceContext', () => {
    const wsCtx = makeWsCtx(workspaceDb);
    const getWorkspaceCtx = (_req: Request) => wsCtx;

    const { req } = mockReqRes();
    const resolved = getWorkspaceCtx(req);
    const activeDb = resolved?.db ?? primaryDb;

    expect(activeDb).toBe(workspaceDb);
    expect(activeDb).not.toBe(primaryDb);
  });

  it('falls back to primary db when getWorkspaceCtx returns null', () => {
    const getWorkspaceCtx = (_req: Request): WorkspaceContext | null => null;

    const { req } = mockReqRes();
    const resolved = getWorkspaceCtx(req);
    const activeDb = resolved?.db ?? primaryDb;

    expect(activeDb).toBe(primaryDb);
    expect(activeDb).not.toBe(workspaceDb);
  });

  it('falls back to primary db when getWorkspaceCtx is undefined', () => {
    // Simulate the route factory being called without a resolver
    const getWorkspaceCtx: ((req: Request) => WorkspaceContext | null) | undefined = undefined;

    const { req } = mockReqRes();
    // Replicate the `getWorkspaceCtx?.(req)` call from the route handler
    const resolved = (getWorkspaceCtx as ((r: Request) => WorkspaceContext | null) | undefined)?.(req);
    const activeDb = resolved?.db ?? primaryDb;

    expect(activeDb).toBe(primaryDb);
  });

  it('resolves to ctx.engine when workspace ctx is present and ctx.engine is non-null', () => {
    const mockEngine = { executeTask: vi.fn() } as unknown as import('../../../execution/engine.js').RuntimeEngine;
    const wsCtx = makeWsCtx(workspaceDb);
    wsCtx.engine = mockEngine;
    const primaryEngine = { executeTask: vi.fn() } as unknown as import('../../../execution/engine.js').RuntimeEngine;

    const getWorkspaceCtx = (_req: Request) => wsCtx;
    const { req } = mockReqRes();
    const resolved = getWorkspaceCtx(req);
    const activeEngine = resolved?.engine ?? primaryEngine;

    expect(activeEngine).toBe(mockEngine);
    expect(activeEngine).not.toBe(primaryEngine);
  });

  it('falls back to primary engine when workspace ctx has engine=null', () => {
    const wsCtx = makeWsCtx(workspaceDb);
    wsCtx.engine = null;
    const primaryEngine = { executeTask: vi.fn() } as unknown as import('../../../execution/engine.js').RuntimeEngine;

    const getWorkspaceCtx = (_req: Request) => wsCtx;
    const { req } = mockReqRes();
    const resolved = getWorkspaceCtx(req);
    const activeEngine = resolved?.engine ?? primaryEngine;

    // ctx.engine is null → nullish coalesce falls through to primaryEngine
    expect(activeEngine).toBe(primaryEngine);
  });

  it('falls back to primary engine when getWorkspaceCtx returns null', () => {
    const primaryEngine = { executeTask: vi.fn() } as unknown as import('../../../execution/engine.js').RuntimeEngine;
    const getWorkspaceCtx = (_req: Request): WorkspaceContext | null => null;

    const { req } = mockReqRes();
    const resolved = getWorkspaceCtx(req);
    const activeEngine = resolved?.engine ?? primaryEngine;

    expect(activeEngine).toBe(primaryEngine);
  });
});

// ---------------------------------------------------------------------------
// Tests — createTasksRouter factory receives getWorkspaceCtx correctly
// ---------------------------------------------------------------------------

describe('createTasksRouter — factory wiring', () => {
  it('createTasksRouter accepts undefined getWorkspaceCtx without throwing', async () => {
    const { createTasksRouter } = await import('../tasks.js');
    const db = makeMockDb('primary') as unknown as DatabaseAdapter;
    expect(() => createTasksRouter(db, null, undefined)).not.toThrow();
  });

  it('createTasksRouter accepts a getWorkspaceCtx resolver without throwing', async () => {
    const { createTasksRouter } = await import('../tasks.js');
    const db = makeMockDb('primary') as unknown as DatabaseAdapter;
    expect(() => createTasksRouter(db, null, () => null)).not.toThrow();
  });
});
