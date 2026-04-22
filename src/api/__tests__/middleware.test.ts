import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import { createAuthMiddleware } from '../middleware.js';
import { signDaemonToken } from '../../daemon/token-codec.js';
import type { Request, Response, NextFunction } from 'express';
import type { WorkspaceDbPool } from '../../db/workspace-db-pool.js';
import type { WorkspaceRegistry } from '../../daemon/workspace-registry.js';
import type { WorkspaceContext } from '../../daemon/workspace-context.js';

const JWT_SECRET = 'test-secret';
const LOCAL_SESSION = 'test-session';

function mockReqResNext(headers: Record<string, string | undefined> = {}, url = '/api/tasks') {
  const req = {
    headers: { ...headers },
    originalUrl: url,
    workspaceId: undefined as string | undefined,
    userId: undefined as string | undefined,
  } as Request;

  const resBody: { status?: number; json?: unknown } = {};
  const res = {
    status: vi.fn().mockImplementation((code: number) => {
      resBody.status = code;
      return res;
    }),
    json: vi.fn().mockImplementation((body: unknown) => {
      resBody.json = body;
    }),
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next, resBody };
}

async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('ohwow-cloud')
    .setExpirationTime('1h')
    .sign(key);
}

describe('createAuthMiddleware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 with no Authorization header', async () => {
    const middleware = createAuthMiddleware(JWT_SECRET, LOCAL_SESSION);
    const { req, res, next } = mockReqResNext();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('authorization') }));
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts local session token (fast path)', async () => {
    const middleware = createAuthMiddleware(JWT_SECRET, LOCAL_SESSION);
    const { req, res, next } = mockReqResNext({
      authorization: `Bearer ${LOCAL_SESSION}`,
    });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.workspaceId).toBe('local');
    expect(req.userId).toBe('local');
  });

  it('verifies HS256 JWT and sets workspace/user from claims', async () => {
    const token = await signJwt({
      type: 'content',
      workspaceId: 'ws-123',
      userId: 'user-456',
    }, JWT_SECRET);

    const middleware = createAuthMiddleware(JWT_SECRET, LOCAL_SESSION);
    const { req, res, next } = mockReqResNext({
      authorization: `Bearer ${token}`,
    });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.workspaceId).toBe('ws-123');
    expect(req.userId).toBe('user-456');
  });

  it('returns 401 for expired JWT', async () => {
    const key = new TextEncoder().encode(JWT_SECRET);
    const expiredToken = await new SignJWT({ type: 'content', workspaceId: 'ws-1', userId: 'u-1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('ohwow-cloud')
      .setExpirationTime('0s')
      .sign(key);

    // Wait a tick for the token to expire
    await new Promise(resolve => setTimeout(resolve, 1100));

    const middleware = createAuthMiddleware(JWT_SECRET, LOCAL_SESSION);
    const { req, res, next } = mockReqResNext({
      authorization: `Bearer ${expiredToken}`,
    });

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for malformed JWT', async () => {
    const middleware = createAuthMiddleware(JWT_SECRET, LOCAL_SESSION);
    const { req, res, next } = mockReqResNext({
      authorization: 'Bearer not-a-valid-jwt',
    });

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for invalid token type', async () => {
    const token = await signJwt({
      type: 'refresh', // wrong type, should be 'content'
      workspaceId: 'ws-123',
      userId: 'user-456',
    }, JWT_SECRET);

    const middleware = createAuthMiddleware(JWT_SECRET, LOCAL_SESSION);
    const { req, res, next } = mockReqResNext({
      authorization: `Bearer ${token}`,
    });

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('token type') }));
  });

  it('accepts valid X-Peer-Token header', async () => {
    const mockDb = {
      from: vi.fn().mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {};
        for (const m of ['select', 'eq']) chain[m] = vi.fn().mockReturnValue(chain);
        chain.maybeSingle = vi.fn().mockResolvedValue({
          data: { id: 'peer-1', status: 'connected' },
          error: null,
        });
        chain.update = vi.fn().mockReturnValue(chain);
        chain.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) => resolve({ data: null, error: null }));
        return chain;
      }),
    };

    const middleware = createAuthMiddleware(JWT_SECRET, LOCAL_SESSION, undefined, mockDb as never);
    const { req, res, next } = mockReqResNext({
      'x-peer-token': 'valid-peer-token',
    });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.workspaceId).toBe('local');
    expect(req.userId).toBe('peer:peer-1');
  });

  it('updates peer last_seen_at on valid peer auth', async () => {
    const updateFn = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        then: vi.fn().mockImplementation((r: (v: unknown) => void) => r({ data: null, error: null })),
      }),
    });

    const mockDb = {
      from: vi.fn().mockImplementation((table: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {};
        for (const m of ['select', 'eq']) chain[m] = vi.fn().mockReturnValue(chain);
        chain.maybeSingle = vi.fn().mockResolvedValue({
          data: table === 'workspace_peers' ? { id: 'peer-1', status: 'connected' } : null,
          error: null,
        });
        chain.update = updateFn;
        chain.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) => resolve({ data: null, error: null }));
        return chain;
      }),
    };

    const middleware = createAuthMiddleware(JWT_SECRET, LOCAL_SESSION, undefined, mockDb as never);
    const { req, res, next } = mockReqResNext({ 'x-peer-token': 'tok' });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(updateFn).toHaveBeenCalled();
    const updateArg = updateFn.mock.calls[0][0] as { last_seen_at: string };
    expect(updateArg).toHaveProperty('last_seen_at');
  });
});

// ---------------------------------------------------------------------------
// Multi-workspace daemon token path (Phase 1)
// ---------------------------------------------------------------------------

function mockDbPool(opts: { throwOnGet?: boolean } = {}): WorkspaceDbPool {
  return {
    get: vi.fn().mockImplementation(() => {
      if (opts.throwOnGet) throw new Error('Workspace not found');
      return {}; // mock db instance
    }),
    close: vi.fn(),
    closeAll: vi.fn(),
  } as unknown as WorkspaceDbPool;
}

describe('createAuthMiddleware — multi-workspace dbPool path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts daemon JWT and sets req.workspaceName + req.dbPool', async () => {
    const token = await signDaemonToken('default', JWT_SECRET);
    const dbPool = mockDbPool();

    const middleware = createAuthMiddleware(JWT_SECRET, undefined, undefined, undefined, undefined, dbPool);
    const { req, res, next } = mockReqResNext({ authorization: `Bearer ${token}` });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.workspaceName).toBe('default');
    expect(req.dbPool).toBe(dbPool);
    expect(req.userId).toBe('local');
  });

  it('sets workspaceName from the JWT claim, not a hardcoded value', async () => {
    const token = await signDaemonToken('avenued', JWT_SECRET);
    const dbPool = mockDbPool();

    const middleware = createAuthMiddleware(JWT_SECRET, undefined, undefined, undefined, undefined, dbPool);
    const { req, res, next } = mockReqResNext({ authorization: `Bearer ${token}` });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.workspaceName).toBe('avenued');
  });

  it('returns 401 when dbPool.get() throws (workspace inaccessible)', async () => {
    const token = await signDaemonToken('missing', JWT_SECRET);
    const dbPool = mockDbPool({ throwOnGet: true });

    const middleware = createAuthMiddleware(JWT_SECRET, undefined, undefined, undefined, undefined, dbPool);
    const { req, res, next } = mockReqResNext({ authorization: `Bearer ${token}` });

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('Workspace') }));
  });

  it('falls through to cloud JWT path when dbPool is undefined (backward compat)', async () => {
    // No dbPool — use classic cloud JWT
    const token = await signJwt({ type: 'content', workspaceId: 'ws-legacy', userId: 'u-legacy' }, JWT_SECRET);

    const middleware = createAuthMiddleware(JWT_SECRET, LOCAL_SESSION);
    const { req, res, next } = mockReqResNext({ authorization: `Bearer ${token}` });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.workspaceId).toBe('ws-legacy');
    expect(req.userId).toBe('u-legacy');
    expect(req.workspaceName).toBeUndefined();
  });

  it('local session token still works when dbPool is present (fast path takes priority)', async () => {
    const dbPool = mockDbPool();

    const middleware = createAuthMiddleware(JWT_SECRET, LOCAL_SESSION, undefined, undefined, undefined, dbPool);
    const { req, res, next } = mockReqResNext({ authorization: `Bearer ${LOCAL_SESSION}` });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.userId).toBe('local');
    // dbPool.get should NOT have been called — session token fast-path runs first
    expect((dbPool.get as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TEST D — Middleware workspaceCtx injection (Phase 2)
// ---------------------------------------------------------------------------

function mockWsCtx(name: string): WorkspaceContext {
  return {
    workspaceName: name,
    workspaceId: 'local',
    dataDir: `/tmp/${name}`,
    sessionToken: `tok-${name}`,
    rawDb: {} as never,
    db: {} as never,
    config: {} as never,
    businessContext: { businessName: name, businessType: 'saas_startup' },
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
    bus: {} as never,
  };
}

function mockRegistry(contexts: WorkspaceContext[]): WorkspaceRegistry {
  const map = new Map(contexts.map(c => [c.workspaceName, c]));
  return {
    has: vi.fn((name: string) => map.has(name)),
    get: vi.fn((name: string) => {
      const ctx = map.get(name);
      if (!ctx) throw new Error(`Workspace '${name}' is not loaded`);
      return ctx;
    }),
    register: vi.fn(),
    getAll: vi.fn(() => [...map.values()]),
    unload: vi.fn(),
    unloadAll: vi.fn(),
  } as unknown as WorkspaceRegistry;
}

describe('createAuthMiddleware — workspaceCtx injection (Phase 2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets req.workspaceCtx when registry.has(workspaceName) is true', async () => {
    const wsCtx = mockWsCtx('default');
    const registry = mockRegistry([wsCtx]);
    const dbPool = mockDbPool();
    const token = await signDaemonToken('default', JWT_SECRET);

    const middleware = createAuthMiddleware(JWT_SECRET, undefined, undefined, undefined, undefined, dbPool, registry);
    const { req, res, next } = mockReqResNext({ authorization: `Bearer ${token}` });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.workspaceCtx).toBe(wsCtx);
    expect(req.workspaceName).toBe('default');
  });

  it('leaves req.workspaceCtx undefined when registry.has(workspaceName) is false', async () => {
    const registry = mockRegistry([]); // empty — no workspace loaded
    const dbPool = mockDbPool();
    const token = await signDaemonToken('default', JWT_SECRET);

    const middleware = createAuthMiddleware(JWT_SECRET, undefined, undefined, undefined, undefined, dbPool, registry);
    const { req, res, next } = mockReqResNext({ authorization: `Bearer ${token}` });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.workspaceCtx).toBeUndefined();
  });

  it('does not set req.workspaceCtx when registry is undefined (old single-workspace path)', async () => {
    const dbPool = mockDbPool();
    const token = await signDaemonToken('default', JWT_SECRET);

    // No registry arg — simulates old single-workspace boot
    const middleware = createAuthMiddleware(JWT_SECRET, undefined, undefined, undefined, undefined, dbPool);
    const { req, res, next } = mockReqResNext({ authorization: `Bearer ${token}` });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.workspaceCtx).toBeUndefined();
  });

  it('injects the correct context for a secondary workspace (avenued)', async () => {
    const defaultCtx = mockWsCtx('default');
    const avenueCtx = mockWsCtx('avenued');
    const registry = mockRegistry([defaultCtx, avenueCtx]);
    const dbPool = mockDbPool();
    const token = await signDaemonToken('avenued', JWT_SECRET);

    const middleware = createAuthMiddleware(JWT_SECRET, undefined, undefined, undefined, undefined, dbPool, registry);
    const { req, res, next } = mockReqResNext({ authorization: `Bearer ${token}` });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.workspaceCtx).toBe(avenueCtx);
    expect(req.workspaceCtx).not.toBe(defaultCtx);
  });
});
