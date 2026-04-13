/**
 * MCP Routes Regression Tests
 *
 * Specifically guards against the "[object Object]" is not valid JSON bug:
 * the SQLite adapter auto-parses JSON string columns on read
 * (src/db/sqlite-adapter.ts:175), so by the time route code touches
 * `data.value` from runtime_settings it is ALREADY a parsed array. Calling
 * JSON.parse() on the array coerces it to "[object Object]" and throws.
 *
 * These tests exercise the GET /api/mcp/servers handler with a mock that
 * mimics the adapter's auto-parse behavior, and round-trip via the POST
 * handler too.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, Router } from 'express';
import { createMcpRouter } from '../routes/mcp.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

/* ── Test helpers ────────────────────────────────────────────────── */

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
    params: {},
    query: {},
    body: {},
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function findHandler(
  router: Router,
  method: string,
  path: string,
): (req: Request, res: Response) => Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layers = (router as any).stack as Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> };
  }>;
  for (const layer of layers) {
    if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      const handlers = layer.route.stack.map((s) => s.handle);
      return async (req: Request, res: Response) => {
        for (const handler of handlers) {
          let called = false;
          const next = () => { called = true; };
          await handler(req, res, next);
          if (!called) return;
        }
      };
    }
  }
  throw new Error(`Handler not found: ${method.toUpperCase()} ${path}`);
}

/**
 * Build a minimal in-memory DB stub that mimics the production
 * SQLite-adapter contract for the runtime_settings table:
 *
 *  - On insert/update, the adapter JSON.stringifies object/array values
 *    before storing, but pass-through string values unchanged.
 *  - On read, the adapter calls parseJsonColumns which auto-parses any
 *    string column starting with `{` or `[` back into an object/array.
 *
 * The stub stores the LAST written `value` for each key. When read, it
 * mirrors the adapter's auto-parse: if the stored value is a JSON-shaped
 * string, it's returned as the parsed object/array; otherwise it's
 * returned as-is.
 */
function makeRuntimeSettingsDb(initial: Record<string, unknown> = {}): DatabaseAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store: Record<string, any> = { ...initial };

  function serializeOnWrite(v: unknown): unknown {
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return v;
  }

  function deserializeOnRead(v: unknown): unknown {
    if (typeof v !== 'string') return v;
    if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
      try { return JSON.parse(v); } catch { return v; }
    }
    return v;
  }

  function makeChain(table: string) {
    if (table !== 'runtime_settings') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const empty: any = {};
      for (const m of ['select', 'eq', 'insert', 'update', 'delete', 'maybeSingle', 'single']) {
        empty[m] = vi.fn().mockReturnValue(empty);
      }
      empty.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      empty.single = vi.fn().mockResolvedValue({ data: null, error: null });
      return empty;
    }

    let pendingKey: string | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockImplementation((column: string, value: unknown) => {
      if (column === 'key') pendingKey = String(value);
      return chain;
    });
    chain.maybeSingle = vi.fn().mockImplementation(async () => {
      if (pendingKey === null) return { data: null, error: null };
      const stored = store[pendingKey];
      if (stored === undefined) return { data: null, error: null };
      // Mimic the adapter: auto-parse JSON-shaped strings on read.
      return { data: { key: pendingKey, value: deserializeOnRead(stored) }, error: null };
    });
    chain.insert = vi.fn().mockImplementation(async (row: Record<string, unknown>) => {
      const key = String(row.key);
      store[key] = serializeOnWrite(row.value);
      return { data: null, error: null };
    });
    chain.update = vi.fn().mockImplementation((row: Record<string, unknown>) => {
      const updateChain = {
        eq: vi.fn().mockImplementation(async (_col: string, value: unknown) => {
          store[String(value)] = serializeOnWrite(row.value);
          return { data: null, error: null };
        }),
      };
      return updateChain;
    });
    return chain;
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from: vi.fn().mockImplementation((table: string) => makeChain(table)) as any,
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  } as unknown as DatabaseAdapter;
}

/* ── Tests ───────────────────────────────────────────────────────── */

describe('GET /api/mcp/servers', () => {
  let router: Router;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles an already-parsed array from the adapter (regression: "[object Object]" is not valid JSON)', async () => {
    // Simulate the adapter's auto-parse: the stored value is a JSON string,
    // but the read returns it pre-parsed as an array.
    const stored = [
      {
        name: 'avenued-prod-superadmin',
        transport: 'http',
        url: 'https://www.aved.ai/api/mcp',
        headers: { Authorization: 'Bearer sk-secret' },
      },
    ];
    const db = makeRuntimeSettingsDb({ global_mcp_servers: stored });
    router = createMcpRouter(db, null);

    const handler = findHandler(router, 'get', '/api/mcp/servers');
    const res = makeRes();
    await handler(makeReq(), res as unknown as Response);

    // Must NOT have errored out
    expect(res._status).toBe(200);
    const body = res._body as { servers: Array<Record<string, unknown>> };
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0].name).toBe('avenued-prod-superadmin');
    expect(body.servers[0].url).toBe('https://www.aved.ai/api/mcp');
    // Credential value must be redacted, not echoed
    expect(body.servers[0].headers).toEqual({ Authorization: '<set>' });
    expect(JSON.stringify(body)).not.toContain('sk-secret');
  });

  it('handles a raw JSON string (defensive — if adapter behavior changes)', async () => {
    const db = makeRuntimeSettingsDb({
      global_mcp_servers: '[{"name":"foo","transport":"http","url":"https://example.com/mcp"}]',
    });
    router = createMcpRouter(db, null);

    const handler = findHandler(router, 'get', '/api/mcp/servers');
    const res = makeRes();
    await handler(makeReq(), res as unknown as Response);

    expect(res._status).toBe(200);
    const body = res._body as { servers: Array<Record<string, unknown>> };
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0].name).toBe('foo');
  });

  it('returns empty list when row does not exist', async () => {
    const db = makeRuntimeSettingsDb({});
    router = createMcpRouter(db, null);

    const handler = findHandler(router, 'get', '/api/mcp/servers');
    const res = makeRes();
    await handler(makeReq(), res as unknown as Response);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ servers: [] });
  });

  it('returns empty list when row is corrupted (literal "[object Object]")', async () => {
    // This is the exact corruption shape the bug report described.
    const db = makeRuntimeSettingsDb({ global_mcp_servers: '[object Object]' });
    router = createMcpRouter(db, null);

    const handler = findHandler(router, 'get', '/api/mcp/servers');
    const res = makeRes();
    await handler(makeReq(), res as unknown as Response);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ servers: [] });
  });
});

describe('POST /api/mcp/servers → GET round trip', () => {
  it('register then list returns the server with credentials redacted', async () => {
    const db = makeRuntimeSettingsDb({});
    const router = createMcpRouter(db, null);

    // Register
    const postHandler = findHandler(router, 'post', '/api/mcp/servers');
    const postRes = makeRes();
    await postHandler(
      makeReq({
        body: {
          name: 'acme',
          transport: 'http',
          url: 'https://acme.example/api/mcp',
          headers: { Authorization: 'Bearer sk-very-secret' },
          description: 'ACME',
        },
      }),
      postRes as unknown as Response,
    );
    expect(postRes._status).toBe(200);
    expect((postRes._body as { ok: boolean }).ok).toBe(true);

    // List — this is where the original bug crashed with
    // SyntaxError: "[object Object]" is not valid JSON
    const getHandler = findHandler(router, 'get', '/api/mcp/servers');
    const getRes = makeRes();
    await getHandler(makeReq(), getRes as unknown as Response);

    expect(getRes._status).toBe(200);
    const listed = getRes._body as { servers: Array<Record<string, unknown>> };
    expect(listed.servers).toHaveLength(1);
    expect(listed.servers[0].name).toBe('acme');
    expect(listed.servers[0].url).toBe('https://acme.example/api/mcp');
    expect(listed.servers[0].headers).toEqual({ Authorization: '<set>' });
    expect(listed.servers[0].description).toBe('ACME');
    expect(JSON.stringify(listed)).not.toContain('sk-very-secret');
  });

  it('register, then register a different name, then list both', async () => {
    const db = makeRuntimeSettingsDb({});
    const router = createMcpRouter(db, null);
    const postHandler = findHandler(router, 'post', '/api/mcp/servers');

    for (const name of ['alpha', 'beta']) {
      const res = makeRes();
      await postHandler(
        makeReq({
          body: { name, transport: 'http', url: `https://${name}.example.com/mcp` },
        }),
        res as unknown as Response,
      );
      expect(res._status).toBe(200);
    }

    const getHandler = findHandler(router, 'get', '/api/mcp/servers');
    const getRes = makeRes();
    await getHandler(makeReq(), getRes as unknown as Response);
    const listed = getRes._body as { servers: Array<{ name: string }> };
    expect(listed.servers.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('rejects duplicate names with 409', async () => {
    const db = makeRuntimeSettingsDb({});
    const router = createMcpRouter(db, null);
    const postHandler = findHandler(router, 'post', '/api/mcp/servers');

    const first = makeRes();
    await postHandler(
      makeReq({ body: { name: 'dup', transport: 'http', url: 'https://example.com/mcp' } }),
      first as unknown as Response,
    );
    expect(first._status).toBe(200);

    const second = makeRes();
    await postHandler(
      makeReq({ body: { name: 'dup', transport: 'http', url: 'https://example.com/mcp' } }),
      second as unknown as Response,
    );
    expect(second._status).toBe(409);
  });
});
