import { describe, it, expect, vi } from 'vitest';
import { ToolExecutorRegistry } from '../tool-dispatch/registry.js';
import { createDefaultToolRegistry } from '../tool-dispatch/index.js';
import type { ToolExecutor, ToolExecutionContext } from '../tool-dispatch/types.js';

function makeCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    taskId: 'test-task',
    agentId: 'test-agent',
    workspaceId: 'test-workspace',
    scraplingService: {} as never,
    fileAccessGuard: null,
    mcpClients: null,
    circuitBreaker: { isDisabled: () => false, recordSuccess: vi.fn(), recordFailure: vi.fn() } as never,
    db: { from: vi.fn().mockReturnValue({ update: vi.fn().mockReturnValue({ eq: vi.fn() }) }) } as never,
    browserService: null,
    browserActivated: false,
    desktopService: null,
    desktopActivated: false,
    ...overrides,
  };
}

describe('ToolExecutorRegistry', () => {
  it('registers and dispatches to the correct executor', async () => {
    const registry = new ToolExecutorRegistry();
    const executor: ToolExecutor = {
      canHandle: (name) => name === 'my_tool',
      execute: async () => ({ content: 'result' }),
    };

    registry.register(executor);
    const result = await registry.execute('my_tool', {}, makeCtx());
    expect(result.content).toBe('result');
  });

  it('returns error for unknown tool', async () => {
    const registry = new ToolExecutorRegistry();
    const result = await registry.execute('unknown', {}, makeCtx());
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Unknown tool');
  });

  it('findExecutor returns the first matching executor', () => {
    const registry = new ToolExecutorRegistry();
    const exec1: ToolExecutor = {
      canHandle: (name) => name.startsWith('a_'),
      execute: async () => ({ content: 'exec1' }),
    };
    const exec2: ToolExecutor = {
      canHandle: (name) => name.startsWith('a_'),
      execute: async () => ({ content: 'exec2' }),
    };

    registry.register(exec1);
    registry.register(exec2);
    expect(registry.findExecutor('a_tool')).toBe(exec1);
  });
});

describe('createDefaultToolRegistry', () => {
  it('creates a registry that handles known tool types', () => {
    const registry = createDefaultToolRegistry();

    // request_browser should be handled
    expect(registry.findExecutor('request_browser')).toBeDefined();

    // draft tools should be handled
    expect(registry.findExecutor('gmail_draft_email')).toBeDefined();
  });

  it('returns error for tools with no executor', async () => {
    const registry = createDefaultToolRegistry();
    const result = await registry.execute('totally_unknown_tool', {}, makeCtx());
    expect(result.is_error).toBe(true);
  });
});

describe('draft executor via registry', () => {
  it('saves deferred action', async () => {
    const registry = createDefaultToolRegistry();
    const mockEq = vi.fn();
    const mockUpdate = vi.fn().mockReturnValue({ eq: mockEq });
    const mockFrom = vi.fn().mockReturnValue({ update: mockUpdate });

    const ctx = makeCtx({
      db: { from: mockFrom } as never,
      taskId: 'task-123',
    });

    const result = await registry.execute('gmail_draft_email', { to: 'test@test.com' }, ctx);
    expect(result.content).toContain('Draft saved');
    expect(mockFrom).toHaveBeenCalledWith('agent_workforce_tasks');
  });
});
