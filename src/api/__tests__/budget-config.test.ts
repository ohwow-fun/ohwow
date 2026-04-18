/**
 * Budget config route tests — pins GET/PUT /api/budget/limit. Gap 13 pin.
 *
 * Strategy: the route reads / writes the workspace config via
 * `resolveActiveWorkspace` + `readWorkspaceConfig` + `writeWorkspaceConfig`
 * from src/config.ts. The real filesystem layer is not what we're
 * pinning here — the value is the handler logic (shape, validation,
 * source resolution, engine refresh). Mock the config module to a tiny
 * in-memory store so the test stays hermetic and doesn't touch the
 * host's ~/.ohwow/workspaces tree.
 *
 * Pattern cloned from api/__tests__/findings-route.test.ts for the
 * Express layer unwrap helper (findHandler + makeRes).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { Router } from 'express';

// ---------------------------------------------------------------------------
// Mock the config module so workspace reads/writes land in a test-owned
// Map instead of the real filesystem.
// ---------------------------------------------------------------------------

interface TestWorkspaceConfig {
  schemaVersion: 1;
  mode: 'local-only' | 'cloud';
  licenseKey?: string;
  autonomousSpendLimitUsd?: number;
  [k: string]: unknown;
}

const testWorkspaceStore = new Map<string, TestWorkspaceConfig>();
let testActiveWorkspace = 'default';

vi.mock('../../config.js', () => ({
  resolveActiveWorkspace: () => ({
    name: testActiveWorkspace,
    dataDir: `/tmp/ohwow-test/${testActiveWorkspace}`,
    dbPath: `/tmp/ohwow-test/${testActiveWorkspace}/runtime.db`,
    skillsDir: `/tmp/ohwow-test/${testActiveWorkspace}/skills`,
    compiledSkillsDir: `/tmp/ohwow-test/${testActiveWorkspace}/skills/.compiled`,
  }),
  readWorkspaceConfig: (name: string) => testWorkspaceStore.get(name) ?? null,
  writeWorkspaceConfig: (name: string, cfg: TestWorkspaceConfig) => {
    testWorkspaceStore.set(name, { ...cfg, schemaVersion: 1 });
  },
}));

// Import after the mock so the route picks up the mocked module.
const { createBudgetConfigRouter } = await import('../routes/budget-config.js');

// ---------------------------------------------------------------------------
// Express unwrap helpers (pattern from findings-route.test.ts)
// ---------------------------------------------------------------------------

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

function makeReq(body: Record<string, unknown> = {}): Request {
  return { query: {}, params: {}, body, headers: {} } as unknown as Request;
}

function findHandler(
  router: Router,
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

// ---------------------------------------------------------------------------
// Minimal engine stub: carries a budgetDeps bag with a mock meter + a
// setBudgetDeps spy so the PUT-path refresh call is observable.
// ---------------------------------------------------------------------------

interface EngineStub {
  budgetDeps: {
    meter: { getCumulativeAutonomousSpendUsd: ReturnType<typeof vi.fn> };
    emittedToday: Set<string>;
    emitPulse: (...args: unknown[]) => void;
  } | null;
  setBudgetDeps: ReturnType<typeof vi.fn>;
  _refreshedTo?: number;
}

function makeEngineStub(spendTodayUsd = 0): EngineStub {
  const meter = {
    getCumulativeAutonomousSpendUsd: vi.fn().mockResolvedValue(spendTodayUsd),
  };
  const stub: EngineStub = {
    budgetDeps: { meter, emittedToday: new Set(), emitPulse: () => {} },
    setBudgetDeps: vi.fn(),
  };
  stub.setBudgetDeps.mockImplementation((deps: unknown, limitUsd?: number) => {
    stub._refreshedTo = limitUsd;
  });
  return stub;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('budget-config route', () => {
  beforeEach(() => {
    testWorkspaceStore.clear();
    testActiveWorkspace = 'default';
  });
  afterEach(() => {
    testWorkspaceStore.clear();
  });

  describe('GET /api/budget/limit', () => {
    it('returns { limitUsd, spentTodayUsd, source } with source=workspace.json when override present', async () => {
      testActiveWorkspace = 'default';
      testWorkspaceStore.set('default', {
        schemaVersion: 1,
        mode: 'local-only',
        autonomousSpendLimitUsd: 42,
      });
      const engine = makeEngineStub(7.5);
      const router = createBudgetConfigRouter({
        engine: engine as never,
        workspaceId: 'default',
        globalLimitUsd: 50,
        globalLimitExplicit: false,
      });
      const handler = findHandler(router, 'get', '/api/budget/limit');
      const res = makeRes();
      await handler(makeReq(), res as unknown as Response);

      expect(res._status).toBe(200);
      const body = res._body as { data: { limitUsd: number; spentTodayUsd: number; source: string; workspace: string } };
      expect(body.data.limitUsd).toBe(42);
      expect(body.data.spentTodayUsd).toBe(7.5);
      expect(body.data.source).toBe('workspace.json');
      expect(body.data.workspace).toBe('default');
    });

    it('returns source=global when only the install-wide limit is explicitly set', async () => {
      // No workspace override.
      const engine = makeEngineStub(0);
      const router = createBudgetConfigRouter({
        engine: engine as never,
        workspaceId: 'default',
        globalLimitUsd: 75,
        globalLimitExplicit: true,
      });
      const handler = findHandler(router, 'get', '/api/budget/limit');
      const res = makeRes();
      await handler(makeReq(), res as unknown as Response);

      const body = res._body as { data: { limitUsd: number; source: string } };
      expect(body.data.limitUsd).toBe(75);
      expect(body.data.source).toBe('global');
    });

    it('returns source=default when neither workspace nor explicit global is set', async () => {
      const engine = makeEngineStub(0);
      const router = createBudgetConfigRouter({
        engine: engine as never,
        workspaceId: 'default',
        globalLimitUsd: 50, // loadConfig's default, not an explicit override
        globalLimitExplicit: false,
      });
      const handler = findHandler(router, 'get', '/api/budget/limit');
      const res = makeRes();
      await handler(makeReq(), res as unknown as Response);

      const body = res._body as { data: { limitUsd: number; source: string } };
      expect(body.data.limitUsd).toBe(50);
      expect(body.data.source).toBe('default');
    });

    it('reports spentTodayUsd=0 when the meter read throws, not 500', async () => {
      const meter = {
        getCumulativeAutonomousSpendUsd: vi.fn().mockRejectedValue(new Error('db hiccup')),
      };
      const engine: EngineStub = {
        budgetDeps: { meter, emittedToday: new Set(), emitPulse: () => {} },
        setBudgetDeps: vi.fn(),
      };
      const router = createBudgetConfigRouter({
        engine: engine as never,
        workspaceId: 'default',
        globalLimitUsd: 50,
        globalLimitExplicit: true,
      });
      const handler = findHandler(router, 'get', '/api/budget/limit');
      const res = makeRes();
      await handler(makeReq(), res as unknown as Response);

      expect(res._status).toBe(200);
      const body = res._body as { data: { spentTodayUsd: number } };
      expect(body.data.spentTodayUsd).toBe(0);
    });
  });

  describe('PUT /api/budget/limit validation', () => {
    const makeRouter = (engine: EngineStub | null = makeEngineStub()) =>
      createBudgetConfigRouter({
        engine: engine as never,
        workspaceId: 'default',
        globalLimitUsd: 50,
        globalLimitExplicit: false,
      });

    it('rejects negative numbers with 400 and "positive number" hint', async () => {
      const router = makeRouter();
      const handler = findHandler(router, 'put', '/api/budget/limit');
      const res = makeRes();
      await handler(makeReq({ limitUsd: -5 }), res as unknown as Response);

      expect(res._status).toBe(400);
      const body = res._body as { error: string };
      expect(body.error.toLowerCase()).toContain('positive');
      // House style: no "Please"
      expect(body.error).not.toMatch(/\bPlease\b/);
    });

    it('rejects zero with 400', async () => {
      const router = makeRouter();
      const handler = findHandler(router, 'put', '/api/budget/limit');
      const res = makeRes();
      await handler(makeReq({ limitUsd: 0 }), res as unknown as Response);
      expect(res._status).toBe(400);
    });

    it('rejects NaN / non-finite with 400', async () => {
      const router = makeRouter();
      const handler = findHandler(router, 'put', '/api/budget/limit');
      const res = makeRes();
      await handler(makeReq({ limitUsd: 'abc' }), res as unknown as Response);
      expect(res._status).toBe(400);
    });

    it('rejects missing field with 400', async () => {
      const router = makeRouter();
      const handler = findHandler(router, 'put', '/api/budget/limit');
      const res = makeRes();
      await handler(makeReq({}), res as unknown as Response);
      expect(res._status).toBe(400);
    });

    it('rejects values above the 10_000 ceiling with 400 mentioning the bound', async () => {
      const router = makeRouter();
      const handler = findHandler(router, 'put', '/api/budget/limit');
      const res = makeRes();
      await handler(makeReq({ limitUsd: 99_999 }), res as unknown as Response);

      expect(res._status).toBe(400);
      const body = res._body as { error: string };
      expect(body.error).toContain('10000');
    });
  });

  describe('PUT /api/budget/limit persistence + engine refresh', () => {
    it('writes the new limit into workspace.json and refreshes the engine budget', async () => {
      testActiveWorkspace = 'default';
      const engine = makeEngineStub();
      const router = createBudgetConfigRouter({
        engine: engine as never,
        workspaceId: 'default',
        globalLimitUsd: 50,
        globalLimitExplicit: false,
        currentTier: 'free',
        currentLicenseKey: undefined,
      });
      const handler = findHandler(router, 'put', '/api/budget/limit');
      const res = makeRes();
      await handler(makeReq({ limitUsd: 125 }), res as unknown as Response);

      expect(res._status).toBe(200);
      const persisted = testWorkspaceStore.get('default');
      expect(persisted).toBeDefined();
      expect(persisted?.autonomousSpendLimitUsd).toBe(125);
      expect(persisted?.schemaVersion).toBe(1);
      expect(persisted?.mode).toBe('local-only'); // inherited from tier=free
      expect(engine.setBudgetDeps).toHaveBeenCalledTimes(1);
      expect(engine._refreshedTo).toBe(125);
      const body = res._body as { data: { limitUsd: number; source: string; workspace: string } };
      expect(body.data).toMatchObject({ limitUsd: 125, source: 'workspace.json', workspace: 'default' });
    });

    it('preserves existing licenseKey + mode when a prior workspace.json is present', async () => {
      testActiveWorkspace = 'default';
      testWorkspaceStore.set('default', {
        schemaVersion: 1,
        mode: 'cloud',
        licenseKey: 'abc123',
        autonomousSpendLimitUsd: 10,
      });
      const engine = makeEngineStub();
      const router = createBudgetConfigRouter({
        engine: engine as never,
        workspaceId: 'default',
        globalLimitUsd: 50,
        globalLimitExplicit: false,
        currentTier: 'connected',
      });
      const handler = findHandler(router, 'put', '/api/budget/limit');
      const res = makeRes();
      await handler(makeReq({ limitUsd: 200 }), res as unknown as Response);

      expect(res._status).toBe(200);
      const persisted = testWorkspaceStore.get('default');
      expect(persisted?.licenseKey).toBe('abc123'); // unchanged
      expect(persisted?.mode).toBe('cloud'); // unchanged
      expect(persisted?.autonomousSpendLimitUsd).toBe(200);
    });

    it('accepts the 10_000 ceiling value itself (inclusive bound)', async () => {
      testActiveWorkspace = 'default';
      const engine = makeEngineStub();
      const router = createBudgetConfigRouter({
        engine: engine as never,
        workspaceId: 'default',
        globalLimitUsd: 50,
        globalLimitExplicit: false,
      });
      const handler = findHandler(router, 'put', '/api/budget/limit');
      const res = makeRes();
      await handler(makeReq({ limitUsd: 10_000 }), res as unknown as Response);

      expect(res._status).toBe(200);
      expect(testWorkspaceStore.get('default')?.autonomousSpendLimitUsd).toBe(10_000);
    });

    it('does not throw when engine is null (pre-boot / test harness)', async () => {
      testActiveWorkspace = 'default';
      const router = createBudgetConfigRouter({
        engine: null,
        workspaceId: 'default',
        globalLimitUsd: 50,
        globalLimitExplicit: false,
      });
      const handler = findHandler(router, 'put', '/api/budget/limit');
      const res = makeRes();
      await handler(makeReq({ limitUsd: 30 }), res as unknown as Response);

      expect(res._status).toBe(200);
      expect(testWorkspaceStore.get('default')?.autonomousSpendLimitUsd).toBe(30);
    });
  });
});
