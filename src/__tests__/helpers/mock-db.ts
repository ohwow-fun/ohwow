/**
 * Shared test helpers for mocking the DatabaseAdapter query builder.
 * Extracted from orchestrator/tools/__tests__/*.test.ts to eliminate duplication.
 */

import { vi } from 'vitest';
import type { LocalToolContext } from '../../orchestrator/local-tool-types.js';

/**
 * Create a mock DatabaseAdapter with chainable query builder.
 * Each table can return different data via `tableOverrides`.
 */
export function mockDb(tableOverrides: Record<string, { data?: unknown; count?: number; error?: unknown }> = {}) {
  const defaults: Record<string, { data: unknown; count: number; error: null }> = {
    agent_workforce_tasks: { data: [], count: 0, error: null },
    agent_workforce_agents: { data: [], count: 0, error: null },
    agent_workforce_projects: { data: [], count: 0, error: null },
  };

  const resolved: Record<string, { data: unknown; count: number; error: unknown }> = { ...defaults };
  for (const [key, val] of Object.entries(tableOverrides)) {
    resolved[key] = { ...defaults[key], ...val };
  }

  function makeChain(table: string) {
    const result = resolved[table] ?? { data: null, count: 0, error: null };
    const terminal = () => ({ data: result.data, count: result.count, error: result.error });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {};
    for (const method of ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'or', 'not', 'order', 'limit', 'range']) {
      chain[method] = vi.fn().mockReturnValue(chain);
    }
    chain.single = vi.fn().mockImplementation(() => Promise.resolve(terminal()));
    chain.maybeSingle = vi.fn().mockImplementation(() => Promise.resolve(terminal()));
    chain.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) => resolve(terminal()));
    chain.insert = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { id: 'task-new' }, error: null }),
      }),
      then: vi.fn().mockImplementation((resolve: (v: unknown) => void) => resolve({ data: null, error: null })),
    });
    chain.update = vi.fn().mockReturnValue(chain);
    chain.delete = vi.fn().mockReturnValue(chain);
    return chain;
  }

  return {
    from: vi.fn().mockImplementation((table: string) => makeChain(table)),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
}

/** Minimal engine mock with common methods. */
export const mockEngine = {
  executeTask: vi.fn(),
};

/**
 * Create a LocalToolContext with a mock DB.
 * Pass `tableOverrides` to customize per-table query results.
 */
export function makeCtx(dbOverrides: Record<string, { data?: unknown; count?: number; error?: unknown }> = {}): LocalToolContext {
  return {
    db: mockDb(dbOverrides) as LocalToolContext['db'],
    workspaceId: 'ws-1',
    engine: mockEngine as unknown as LocalToolContext['engine'],
    channels: {} as LocalToolContext['channels'],
    controlPlane: null,
  };
}
