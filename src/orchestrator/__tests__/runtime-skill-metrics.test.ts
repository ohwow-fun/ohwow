import { describe, it, expect, vi } from 'vitest';
import { recordRuntimeSkillOutcome } from '../runtime-skill-metrics.js';
import { makeCtx } from '../../__tests__/helpers/mock-db.js';
import type { LocalToolContext } from '../local-tool-types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Custom db mock for metrics. We need to control what maybeSingle()
 * returns for the initial read, then capture the update() patch.
 * Typed chain so no scattered casts.
 */
interface MetricsDbChain {
  select: () => MetricsDbChain;
  eq: (col: string, val: unknown) => MetricsDbChain;
  maybeSingle: () => Promise<{ data: { success_count?: number; fail_count?: number; name?: string; promoted_at?: string | null } | null; error: null }>;
}

interface MetricsDbUpdateChain {
  eq: (col: string, id: unknown) => Promise<{ data: null; error: null }>;
}

interface MetricsDbTable {
  select: () => MetricsDbChain;
  update: (patch: Record<string, unknown>) => MetricsDbUpdateChain;
}

function makeMetricsCtx(params: {
  currentSuccess?: number;
  currentFail?: number;
  currentName?: string;
  promotedAt?: string | null;
}): {
  ctx: LocalToolContext;
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
} {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const current = {
    success_count: params.currentSuccess ?? 0,
    fail_count: params.currentFail ?? 0,
    name: params.currentName ?? 'test_skill',
    promoted_at: params.promotedAt ?? null,
  };

  const chain: MetricsDbChain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: current, error: null }),
  };

  const mock = {
    from: (_table: string): MetricsDbTable => ({
      select: () => chain,
      update: (patch: Record<string, unknown>): MetricsDbUpdateChain => ({
        eq: (_col, id) => {
          updates.push({ id: String(id), patch });
          return Promise.resolve({ data: null, error: null });
        },
      }),
    }),
  };

  // One localized widening from the narrow mock surface to
  // DatabaseAdapter — every field the test touches is strictly
  // typed via the chain interfaces above. Assign into a fresh
  // LocalToolContext from the shared mock helper so the rest of
  // the ctx (workspaceId, engine, channels, controlPlane) stays
  // uniform with other tests.
  const ctx: LocalToolContext = { ...makeCtx(), db: mock as unknown as DatabaseAdapter };
  return { ctx, updates };
}

describe('recordRuntimeSkillOutcome', () => {
  it('increments success_count on success', async () => {
    const { ctx, updates } = makeMetricsCtx({ currentSuccess: 2, currentFail: 1 });
    await recordRuntimeSkillOutcome(ctx, 'sk-1', 'success');
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('sk-1');
    expect(updates[0].patch.success_count).toBe(3);
    expect(updates[0].patch.fail_count).toBe(1);
    expect(updates[0].patch.last_used_at).toBeTruthy();
  });

  it('increments fail_count on failure', async () => {
    const { ctx, updates } = makeMetricsCtx({ currentSuccess: 5, currentFail: 2 });
    await recordRuntimeSkillOutcome(ctx, 'sk-2', 'failure');
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.success_count).toBe(5);
    expect(updates[0].patch.fail_count).toBe(3);
  });

  it('starts counters from zero when the row has null counters', async () => {
    const { ctx, updates } = makeMetricsCtx({});
    await recordRuntimeSkillOutcome(ctx, 'sk-3', 'success');
    expect(updates[0].patch.success_count).toBe(1);
    expect(updates[0].patch.fail_count).toBe(0);
  });

  it('does not touch promoted_at', async () => {
    const { ctx, updates } = makeMetricsCtx({
      currentSuccess: 2,
      currentFail: 0,
      promotedAt: '2026-04-13T00:00:00Z',
    });
    await recordRuntimeSkillOutcome(ctx, 'sk-4', 'success');
    expect(updates[0].patch).not.toHaveProperty('promoted_at');
  });
});
