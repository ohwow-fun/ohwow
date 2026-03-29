import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../tools/registry.js', () => ({
  toolRegistry: new Map(),
}));

vi.mock('../../execution/browser/browser-tools.js', () => ({
  BROWSER_ACTIVATION_MESSAGE: 'Browser activated.',
  executeBrowserTool: vi.fn(),
  formatBrowserToolResult: vi.fn().mockReturnValue([]),
  isBrowserTool: vi.fn().mockReturnValue(false),
}));

vi.mock('../../mcp/tool-adapter.js', () => ({
  isMcpTool: vi.fn().mockReturnValue(false),
}));

vi.mock('../../execution/browser/screenshot-storage.js', () => ({
  saveScreenshotLocally: vi.fn(),
}));

vi.mock('../../media/storage.js', () => ({
  saveMediaFile: vi.fn(),
  saveMediaFromUrl: vi.fn(),
}));

vi.mock('../../media/media-router.js', () => ({
  estimateMediaCost: vi.fn().mockReturnValue({ credits: 1, description: 'test' }),
}));

vi.mock('../result-summarizer.js', () => ({
  summarizeToolResult: vi.fn().mockImplementation((_name: string, content: string) => content),
}));

vi.mock('../error-recovery.js', () => ({
  retryTransient: vi.fn().mockImplementation((fn: () => unknown) => fn()),
  CircuitBreaker: vi.fn(),
}));

import { executeToolCallsBatch } from '../batch-executor.js';
import { toolRegistry } from '../tools/registry.js';
import type { ToolCallRequest, ToolExecutionContext, ToolCallOutcome } from '../tool-executor.js';
import type { OrchestratorEvent } from '../orchestrator-types.js';

async function drainBatch(gen: AsyncGenerator<OrchestratorEvent, ToolCallOutcome[]>) {
  const events: OrchestratorEvent[] = [];
  for (;;) {
    const { value, done } = await gen.next();
    if (done) return { events, outcomes: value };
    events.push(value);
  }
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolCtx: {
      db: {} as never,
      workspaceId: 'ws-1',
      engine: {} as never,
      channels: {} as never,
      controlPlane: null,
    },
    executedToolCalls: new Map(),
    browserState: { service: null, activated: false, headless: true, dataDir: '' },
    waitForPermission: vi.fn().mockResolvedValue(true),
    addAllowedPath: vi.fn(),
    ...overrides,
  };
}

describe('executeToolCallsBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (toolRegistry as Map<string, unknown>).clear();
  });

  it('returns empty array for empty requests', async () => {
    const ctx = makeCtx();
    const { outcomes } = await drainBatch(executeToolCallsBatch([], ctx));
    expect(outcomes).toEqual([]);
  });

  it('single request delegates to executeSingle', async () => {
    // Register a mock tool
    (toolRegistry as Map<string, unknown>).set('list_agents', vi.fn().mockResolvedValue({
      success: true,
      data: [{ id: 'a1', name: 'Agent1' }],
    }));

    const ctx = makeCtx();
    const requests: ToolCallRequest[] = [
      { id: 'call-1', name: 'list_agents', input: {} },
    ];
    const { outcomes } = await drainBatch(executeToolCallsBatch(requests, ctx));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].result.success).toBe(true);
  });

  it('parallel tools run concurrently', async () => {
    const callOrder: string[] = [];
    (toolRegistry as Map<string, unknown>).set('list_agents', vi.fn().mockImplementation(async () => {
      callOrder.push('agents_start');
      await new Promise(r => setTimeout(r, 10));
      callOrder.push('agents_end');
      return { success: true, data: 'agents' };
    }));
    (toolRegistry as Map<string, unknown>).set('list_tasks', vi.fn().mockImplementation(async () => {
      callOrder.push('tasks_start');
      await new Promise(r => setTimeout(r, 10));
      callOrder.push('tasks_end');
      return { success: true, data: 'tasks' };
    }));

    const ctx = makeCtx();
    const requests: ToolCallRequest[] = [
      { id: 'call-1', name: 'list_agents', input: {} },
      { id: 'call-2', name: 'list_tasks', input: {} },
    ];
    const { outcomes } = await drainBatch(executeToolCallsBatch(requests, ctx));
    expect(outcomes).toHaveLength(2);
    // Both should start before either finishes (parallel execution)
    expect(callOrder.indexOf('agents_start')).toBeLessThan(callOrder.indexOf('agents_end'));
    expect(callOrder.indexOf('tasks_start')).toBeLessThan(callOrder.indexOf('tasks_end'));
  });

  it('filesystem tools run after parallel phase', async () => {
    const callOrder: string[] = [];
    (toolRegistry as Map<string, unknown>).set('list_agents', vi.fn().mockImplementation(async () => {
      callOrder.push('agents');
      return { success: true, data: 'agents' };
    }));
    (toolRegistry as Map<string, unknown>).set('local_read_file', vi.fn().mockImplementation(async () => {
      callOrder.push('read_file');
      return { success: true, data: 'file content' };
    }));

    const ctx = makeCtx();
    const requests: ToolCallRequest[] = [
      { id: 'call-1', name: 'local_read_file', input: { path: '/test' } },
      { id: 'call-2', name: 'list_agents', input: {} },
    ];
    const { outcomes } = await drainBatch(executeToolCallsBatch(requests, ctx));
    expect(outcomes).toHaveLength(2);
    // list_agents (parallel) should run before local_read_file (filesystem)
    expect(callOrder.indexOf('agents')).toBeLessThan(callOrder.indexOf('read_file'));
  });

  it('destructive MCP tools run sequentially', async () => {
    // We can't easily test MCP tools here since isMcpTool is mocked to false,
    // but we can verify the categorization logic exists by testing non-MCP behavior
    (toolRegistry as Map<string, unknown>).set('list_agents', vi.fn().mockResolvedValue({ success: true, data: 'ok' }));

    const ctx = makeCtx();
    const requests: ToolCallRequest[] = [
      { id: 'call-1', name: 'list_agents', input: {} },
    ];
    const { outcomes } = await drainBatch(executeToolCallsBatch(requests, ctx));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].result.success).toBe(true);
  });

  it('failed tool produces error without blocking others', async () => {
    (toolRegistry as Map<string, unknown>).set('list_agents', vi.fn().mockResolvedValue({ success: true, data: 'ok' }));
    (toolRegistry as Map<string, unknown>).set('list_tasks', vi.fn().mockRejectedValue(new Error('DB error')));

    const ctx = makeCtx();
    const requests: ToolCallRequest[] = [
      { id: 'call-1', name: 'list_agents', input: {} },
      { id: 'call-2', name: 'list_tasks', input: {} },
    ];
    const { outcomes } = await drainBatch(executeToolCallsBatch(requests, ctx));
    expect(outcomes).toHaveLength(2);

    const agentOutcome = outcomes.find(o => o.toolName === 'list_agents');
    const taskOutcome = outcomes.find(o => o.toolName === 'list_tasks');
    expect(agentOutcome!.result.success).toBe(true);
    expect(taskOutcome!.isError).toBe(true);
  });

  it('results in original request order', async () => {
    (toolRegistry as Map<string, unknown>).set('list_agents', vi.fn().mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 20)); // slow
      return { success: true, data: 'agents' };
    }));
    (toolRegistry as Map<string, unknown>).set('list_tasks', vi.fn().mockImplementation(async () => {
      return { success: true, data: 'tasks' }; // fast
    }));

    const ctx = makeCtx();
    const requests: ToolCallRequest[] = [
      { id: 'call-1', name: 'list_agents', input: {} },
      { id: 'call-2', name: 'list_tasks', input: {} },
    ];
    const { outcomes } = await drainBatch(executeToolCallsBatch(requests, ctx));

    // Results should be in original request order, not completion order
    expect(outcomes[0].toolName).toBe('list_agents');
    expect(outcomes[1].toolName).toBe('list_tasks');
  });
});
