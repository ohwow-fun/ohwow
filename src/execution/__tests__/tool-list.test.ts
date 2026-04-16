import { describe, it, expect, vi } from 'vitest';
import { buildTaskToolList } from '../tool-list.js';
import type { TaskCapabilities } from '../task-capabilities.js';
import type { RuntimeEngine } from '../engine.js';

// Minimal no-op policy for inherit mode with empty allow/block lists.
// Same shape `resolveAgentToolPolicy` returns when the agent has no
// tools_mode/tools_enabled override.
const INHERIT_POLICY = {
  mode: 'inherit' as const,
  allowedNames: new Set<string>(),
  blockedNames: new Set<string>(),
  requiresMcp: false,
  referencedMcpServers: new Set<string>(),
};

function makeCaps(overrides: Partial<TaskCapabilities>): TaskCapabilities {
  return {
    webSearchEnabled: false,
    browserEnabled: false,
    desktopEnabled: false,
    scraplingEnabled: false,
    localFilesEnabled: false,
    bashEnabled: false,
    devopsEnabled: false,
    approvalRequired: false,
    mcpEnabled: false,
    autonomyLevel: 3,
    fileAccessGuard: null,
    desktopOptions: undefined,
    goalContext: undefined,
    toolPolicy: INHERIT_POLICY,
    agentMcpServers: [],
    ...overrides,
  } as unknown as TaskCapabilities;
}

function makeFakeEngine(): RuntimeEngine {
  return {
    config: { mcpServers: [] },
    db: {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }),
        }),
      }),
    },
    emit: vi.fn(),
    pendingElicitations: new Map(),
  } as unknown as RuntimeEngine;
}

describe('buildTaskToolList', () => {
  const baseArgs = { taskInput: 'post something', agentId: 'a', taskId: 't' };

  it('exposes x_compose_tweet when browserEnabled=true', async () => {
    const caps = makeCaps({ browserEnabled: true });
    const { tools } = await buildTaskToolList.call(
      makeFakeEngine(),
      { caps, ...baseArgs },
    );
    const names = tools.map((t) => (t as { name?: string }).name).filter(Boolean);
    expect(names).toContain('x_compose_tweet');
    expect(names).toContain('x_compose_thread');
    expect(names).toContain('x_compose_article');
    expect(names).toContain('x_delete_tweet');
  });

  it('exposes x_compose_tweet when desktopEnabled=true even without browser', async () => {
    const caps = makeCaps({ desktopEnabled: true });
    const { tools } = await buildTaskToolList.call(
      makeFakeEngine(),
      { caps, ...baseArgs },
    );
    const names = tools.map((t) => (t as { name?: string }).name).filter(Boolean);
    expect(names).toContain('x_compose_tweet');
  });

  it('does NOT expose x_compose_tweet when neither browser nor desktop is enabled', async () => {
    const caps = makeCaps({});
    const { tools } = await buildTaskToolList.call(
      makeFakeEngine(),
      { caps, ...baseArgs },
    );
    const names = tools.map((t) => (t as { name?: string }).name).filter(Boolean);
    expect(names).not.toContain('x_compose_tweet');
  });

  it('respects allowlist policy — removes x_compose_tweet if not allowed', async () => {
    const caps = makeCaps({
      browserEnabled: true,
      toolPolicy: {
        mode: 'allowlist',
        allowedNames: new Set(['set_state']),
        blockedNames: new Set(),
        requiresMcp: false,
        referencedMcpServers: new Set(),
      } as unknown as TaskCapabilities['toolPolicy'],
    });
    const { tools } = await buildTaskToolList.call(
      makeFakeEngine(),
      { caps, ...baseArgs },
    );
    const names = tools.map((t) => (t as { name?: string }).name).filter(Boolean);
    expect(names).not.toContain('x_compose_tweet');
    expect(names).toContain('set_state');
  });
});
