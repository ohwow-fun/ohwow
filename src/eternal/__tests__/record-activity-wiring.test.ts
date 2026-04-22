/**
 * Pins that createAuthMiddleware calls recordActivity on authenticated paths
 * and does NOT call it on the peer-token path.
 *
 * Strategy: mock ../eternal/index.js so recordActivity is a vi.fn(), build a
 * minimal DatabaseAdapter fake, then fire fake requests through the middleware
 * and assert call counts on the mock.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

// ---------------------------------------------------------------------------
// Mock eternal module — must be declared before the module under test is
// imported so Vitest's hoisting picks it up.
// ---------------------------------------------------------------------------

const mockRecordActivity = vi.fn().mockResolvedValue(undefined);

vi.mock('../index.js', () => ({
  recordActivity: (...args: unknown[]) => mockRecordActivity(...args),
}));

// Mock logger to suppress output.
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock verifyDaemonToken so the daemon JWT fast-path is skipped unless we
// explicitly control it.
vi.mock('../../daemon/token-codec.js', () => ({
  verifyDaemonToken: vi.fn().mockResolvedValue(null),
}));

// Import after mocks.
const { createAuthMiddleware } = await import('../../api/middleware.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal DatabaseAdapter fake. The peer-token path does real chain
 *  calls, so we need a builder that returns itself to support chaining. */
function buildMockDb(): DatabaseAdapter {
  // The peer-token path calls .from('workspace_peers').select().eq().eq().maybeSingle()
  // and returns { data: null } so the peer branch falls through.
  const filterBuilder: Record<string, unknown> = {};
  filterBuilder.eq = vi.fn().mockReturnThis();
  filterBuilder.neq = vi.fn().mockReturnThis();
  filterBuilder.select = vi.fn().mockReturnThis();
  filterBuilder.update = vi.fn().mockReturnThis();
  filterBuilder.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  filterBuilder.then = undefined; // not a thenable at the top level

  const tableBuilder = {
    select: vi.fn().mockReturnValue(filterBuilder),
    insert: vi.fn().mockReturnValue(filterBuilder),
    update: vi.fn().mockReturnValue(filterBuilder),
    delete: vi.fn().mockReturnValue(filterBuilder),
  };

  return {
    from: vi.fn().mockReturnValue(tableBuilder),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  } as DatabaseAdapter;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    originalUrl: '/api/tasks',
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
}

const noop: NextFunction = vi.fn();

const LOCAL_SESSION_TOKEN = 'test-sess-tok';
const JWT_SECRET = 'test-jwt-key';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAuthMiddleware — recordActivity wiring', () => {
  let db: DatabaseAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    db = buildMockDb();
  });

  it('calls recordActivity on the local session token path', async () => {
    const mw = createAuthMiddleware(JWT_SECRET, LOCAL_SESSION_TOKEN, undefined, db);

    const req = makeReq({
      headers: { authorization: `Bearer ${LOCAL_SESSION_TOKEN}` },
    });
    const res = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    // Give fire-and-forget promise a tick to resolve.
    await Promise.resolve();
    expect(mockRecordActivity).toHaveBeenCalledWith(db);
    expect(mockRecordActivity).toHaveBeenCalledTimes(1);
  });

  it('does NOT call recordActivity for the peer-token path', async () => {
    const mw = createAuthMiddleware(JWT_SECRET, LOCAL_SESSION_TOKEN, undefined, db);

    // Peer token path: the maybeSingle mock returns { data: null } by default,
    // so peer is not found and the request falls through to missing-auth 401.
    // To simulate a successful peer auth we need the mock to return a peer row.
    const peerDb = buildMockDb();
    // Override maybeSingle on the filterBuilder to return a peer.
    const mockFilterBuilder = (peerDb.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: 'peer-1', status: 'connected' },
              error: null,
            }),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
      insert: vi.fn(),
      delete: vi.fn(),
    });
    void mockFilterBuilder;

    const mwPeer = createAuthMiddleware(JWT_SECRET, LOCAL_SESSION_TOKEN, undefined, peerDb);

    const req = makeReq({
      headers: { 'x-peer-token': 'peer-tok' },
    });
    const res = makeRes();
    const next = vi.fn();

    await mwPeer(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    // recordActivity must NOT be called for peer-token auth.
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it('does not call recordActivity when db is undefined (local session token)', async () => {
    const mw = createAuthMiddleware(JWT_SECRET, LOCAL_SESSION_TOKEN, undefined, undefined);

    const req = makeReq({
      headers: { authorization: `Bearer ${LOCAL_SESSION_TOKEN}` },
    });
    const res = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });
});
