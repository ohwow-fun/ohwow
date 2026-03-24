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

import { executeToolCall, type ToolCallRequest, type ToolExecutionContext } from '../tool-executor.js';
import { toolRegistry } from '../tools/registry.js';
import { ToolCache } from '../tool-cache.js';
import type { OrchestratorEvent } from '../orchestrator-types.js';

async function drainGen(gen: AsyncGenerator<OrchestratorEvent, unknown>) {
  const events: OrchestratorEvent[] = [];
  for (;;) {
    const { value, done } = await gen.next();
    if (done) return { events, outcome: value };
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

describe('executeToolCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (toolRegistry as Map<string, unknown>).clear();
  });

  it('returns cached result for duplicate tool+input in same turn', async () => {
    const cachedResult = { success: true as const, data: 'cached data' };
    const ctx = makeCtx();
    ctx.executedToolCalls.set('list_agents:{}', cachedResult);

    const request: ToolCallRequest = { id: 'call-1', name: 'list_agents', input: {} };
    const { outcome } = await drainGen(executeToolCall(request, ctx));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((outcome as any).result).toEqual(cachedResult);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((outcome as any).resultContent).toContain('already called');
  });

  it('returns cross-turn cached result from ToolCache', async () => {
    const toolCache = new ToolCache();
    const cachedResult = { success: true as const, data: 'cross-turn data' };
    toolCache.set('list_agents', {}, cachedResult);

    const ctx = makeCtx({ toolCache });
    const request: ToolCallRequest = { id: 'call-1', name: 'list_agents', input: {} };
    const { outcome } = await drainGen(executeToolCall(request, ctx));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((outcome as any).result).toEqual(cachedResult);
  });

  it('handles update_plan tool specially', async () => {
    const ctx = makeCtx();
    const request: ToolCallRequest = {
      id: 'call-1',
      name: 'update_plan',
      input: { tasks: [{ id: 't1', title: 'Do something', status: 'pending' }] },
    };
    const { events, outcome } = await drainGen(executeToolCall(request, ctx));

    const planEvent = events.find(e => e.type === 'plan_update');
    expect(planEvent).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((outcome as any).planTasks).toHaveLength(1);
  });

  it('handles request_browser activation', async () => {
    const ctx = makeCtx();
    const request: ToolCallRequest = { id: 'call-1', name: 'request_browser', input: {} };
    const { outcome } = await drainGen(executeToolCall(request, ctx));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((outcome as any).toolsModified).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((outcome as any).resultContent).toContain('Browser activated');
  });

  it('returns error for unknown tool', async () => {
    const ctx = makeCtx();
    const request: ToolCallRequest = { id: 'call-1', name: 'nonexistent_tool', input: {} };
    const { outcome } = await drainGen(executeToolCall(request, ctx));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((outcome as any).isError).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((outcome as any).resultContent).toContain('Unknown tool');
  });
});
