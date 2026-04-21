/**
 * Unit test: ohwow_list_cdp_events MCP tool
 *
 * Stubs DaemonApiClient.get and verifies:
 *   - tool name is 'ohwow_list_cdp_events'
 *   - params are forwarded as query-string to /api/cdp-trace-events
 *   - the MCP response wraps the daemon reply correctly
 *   - error paths return isError: true
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api-client.js', () => ({
  DaemonApiClient: vi.fn(),
}));

import { registerCdpTraceEventsTools } from '../cdp-trace-events.js';

// ── Minimal McpServer stub ────────────────────────────────────────────────────

interface ToolCallback {
  name: string;
  description: string;
  schema: unknown;
  handler: (params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function makeMcpServer() {
  const tools: ToolCallback[] = [];
  const server = {
    tool: vi.fn().mockImplementation(
      (name: string, description: string, schema: unknown, handler: ToolCallback['handler']) => {
        tools.push({ name, description, schema, handler });
      },
    ),
    _tools: tools,
  };
  return server;
}

// ── DaemonApiClient stub factory ──────────────────────────────────────────────

function makeClient(getImpl: (path: string) => Promise<unknown>) {
  return { get: vi.fn().mockImplementation(getImpl) };
}

// ── Fixture response ──────────────────────────────────────────────────────────

const FIXTURE_RESPONSE = {
  data: [
    {
      id: 'evt-1',
      workspace_id: 'ws',
      ts: '2026-04-20T00:00:00.000Z',
      action: 'claim',
      profile: 'Default',
      target_id: null,
      owner: 'task-1',
      url: null,
      metadata_json: null,
      created_at: '2026-04-20T00:00:00.000Z',
    },
  ],
  count: 1,
  limit: 50,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('registerCdpTraceEventsTools', () => {
  let server: ReturnType<typeof makeMcpServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeMcpServer();
  });

  it('registers a tool named ohwow_list_cdp_events', () => {
    const client = makeClient(async () => FIXTURE_RESPONSE);
    registerCdpTraceEventsTools(server as never, client as never);
    expect(server._tools).toHaveLength(1);
    expect(server._tools[0].name).toBe('ohwow_list_cdp_events');
  });

  it('calls /api/cdp-trace-events with no query string when no params provided', async () => {
    const client = makeClient(async () => FIXTURE_RESPONSE);
    registerCdpTraceEventsTools(server as never, client as never);
    await server._tools[0].handler({});
    expect(client.get).toHaveBeenCalledWith('/api/cdp-trace-events');
  });

  it('forwards action param as query string', async () => {
    const client = makeClient(async () => FIXTURE_RESPONSE);
    registerCdpTraceEventsTools(server as never, client as never);
    await server._tools[0].handler({ action: 'claim' });
    expect(client.get).toHaveBeenCalledWith('/api/cdp-trace-events?action=claim');
  });

  it('forwards multiple params as query string', async () => {
    const client = makeClient(async () => FIXTURE_RESPONSE);
    registerCdpTraceEventsTools(server as never, client as never);
    await server._tools[0].handler({ action: 'claim', limit: 10, owner: 'task-1' });
    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('action=claim');
    expect(url).toContain('limit=10');
    expect(url).toContain('owner=task-1');
  });

  it('returns a JSON text content block on success', async () => {
    const client = makeClient(async () => FIXTURE_RESPONSE);
    registerCdpTraceEventsTools(server as never, client as never);
    const result = await server._tools[0].handler({});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.content[0].text) as typeof FIXTURE_RESPONSE;
    expect(parsed.count).toBe(1);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.limit).toBe(50);
  });

  it('returns isError:true when daemon returns an error field', async () => {
    const client = makeClient(async () => ({ error: 'db is broken' }));
    registerCdpTraceEventsTools(server as never, client as never);
    const result = await server._tools[0].handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('db is broken');
  });

  it('returns isError:true when client.get throws', async () => {
    const client = makeClient(async () => { throw new Error('network error'); });
    registerCdpTraceEventsTools(server as never, client as never);
    const result = await server._tools[0].handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('network error');
  });

  it('wraps empty response with defaults', async () => {
    const client = makeClient(async () => ({}));
    registerCdpTraceEventsTools(server as never, client as never);
    const result = await server._tools[0].handler({});
    const parsed = JSON.parse(result.content[0].text) as { data: unknown[]; count: number; limit: number };
    expect(parsed.data).toEqual([]);
    expect(parsed.count).toBe(0);
    expect(parsed.limit).toBe(50);
  });
});
