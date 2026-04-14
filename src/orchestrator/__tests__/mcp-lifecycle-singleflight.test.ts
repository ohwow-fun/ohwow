/**
 * Regression test for bug #6: ensureMcpConnected() must coalesce concurrent
 * callers into a single in-flight connect, not let four parallel chats each
 * spawn their own McpClientManager.connect().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpLifecycle } from '../orchestrator-mcp-lifecycle.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { PermissionBroker } from '../orchestrator-approvals.js';
import { McpClientManager } from '../../mcp/client.js';

vi.mock('../../mcp/client.js', () => {
  return {
    McpClientManager: {
      connect: vi.fn(),
    },
  };
});

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeStubDb(): DatabaseAdapter {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  } as unknown as DatabaseAdapter;
}

function makeStubBroker(): PermissionBroker {
  return {
    awaitElicitation: async () => null,
  } as unknown as PermissionBroker;
}

describe('McpLifecycle.ensureConnected — singleflight (bug #6 regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('coalesces 50 concurrent callers into one McpClientManager.connect() invocation', async () => {
    let resolveConnect!: (value: unknown) => void;
    const connectPromise = new Promise((res) => { resolveConnect = res; });

    const mockClient = {
      getToolDefinitions: () => [],
      getConnectionFailures: () => [],
      close: vi.fn(),
    };
    vi.mocked(McpClientManager.connect).mockImplementation(async () => {
      await connectPromise;
      return mockClient as unknown as McpClientManager;
    });

    const lifecycle = new McpLifecycle(
      makeStubDb(),
      makeStubBroker(),
      () => { /* noop syncOrgan */ },
      [{ name: 'fake-server', transport: 'stdio', command: 'noop', args: [] }],
    );

    // Fire 50 concurrent ensureConnected() calls before resolving the connect.
    const allCallers = Promise.all(
      Array.from({ length: 50 }, () => lifecycle.ensureConnected()),
    );

    // Allow the microtask queue to drain so all 50 calls hit the singleflight.
    await new Promise((r) => setTimeout(r, 5));
    expect(McpClientManager.connect).toHaveBeenCalledTimes(1);

    // Now resolve the connect and let all 50 callers finish.
    resolveConnect(null);
    await allCallers;

    // Still exactly one connect call, despite 50 callers.
    expect(McpClientManager.connect).toHaveBeenCalledTimes(1);
    expect(lifecycle.getClients()).toBe(mockClient);
  });

  it('takes the fast path on subsequent calls after init succeeds', async () => {
    const mockClient = {
      getToolDefinitions: () => [],
      getConnectionFailures: () => [],
      close: vi.fn(),
    };
    vi.mocked(McpClientManager.connect).mockResolvedValue(mockClient as unknown as McpClientManager);

    const lifecycle = new McpLifecycle(
      makeStubDb(),
      makeStubBroker(),
      () => {},
      [{ name: 'fake-server', transport: 'stdio', command: 'noop', args: [] }],
    );

    await lifecycle.ensureConnected();
    await lifecycle.ensureConnected();
    await lifecycle.ensureConnected();

    expect(McpClientManager.connect).toHaveBeenCalledOnce();
  });

  it('drops the in-flight promise on failure so a retry can run', async () => {
    let attempt = 0;
    vi.mocked(McpClientManager.connect).mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('first connect fails');
      return {
        getToolDefinitions: () => [],
        getConnectionFailures: () => [],
        close: vi.fn(),
      } as unknown as McpClientManager;
    });

    const lifecycle = new McpLifecycle(
      makeStubDb(),
      makeStubBroker(),
      () => {},
      [{ name: 'fake-server', transport: 'stdio', command: 'noop', args: [] }],
    );

    await expect(lifecycle.ensureConnected()).rejects.toThrow('first connect fails');
    expect(McpClientManager.connect).toHaveBeenCalledTimes(1);

    // Retry succeeds because the cached promise was dropped.
    await lifecycle.ensureConnected();
    expect(McpClientManager.connect).toHaveBeenCalledTimes(2);
    expect(lifecycle.getClients()).toBeTruthy();
  });
});
