import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import { createAuthMiddleware } from '../middleware.js';
import type { Request, Response, NextFunction } from 'express';

const JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
const LOCAL_SESSION = 'local-session-token-abc';

function mockReqResNext(headers: Record<string, string | undefined> = {}) {
  const req = {
    headers: { ...headers },
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
