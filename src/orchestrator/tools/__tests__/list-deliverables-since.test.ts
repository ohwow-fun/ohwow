import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { listDeliverables } from '../deliverables.js';
import type { LocalToolContext } from '../../local-tool-types.js';

describe('listDeliverables — since filter', () => {
  const capturedGteCalls: Array<{ column: string; value: string }> = [];

  beforeEach(() => {
    capturedGteCalls.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Chainable mock whose query object is itself thenable, matching the
  // supabase-style builder shape used across the orchestrator's tool
  // handlers. Every chained method returns the same object; await-ing it
  // resolves with an empty result payload.
  function buildCtx(): LocalToolContext {
    const resolvedPayload = { data: [], error: null, count: 0 };
    const builder: Record<string, unknown> = {
      from() { return builder; },
      select() { return builder; },
      eq() { return builder; },
      in() { return builder; },
      is() { return builder; },
      order() { return builder; },
      limit() { return builder; },
      gte(column: string, value: string) {
        capturedGteCalls.push({ column, value });
        return builder;
      },
      then(onFulfilled: (v: typeof resolvedPayload) => unknown) {
        return Promise.resolve(resolvedPayload).then(onFulfilled);
      },
    };
    return { db: builder, workspaceId: 'ws-test' } as unknown as LocalToolContext;
  }

  it('accepts "24h" and translates to ISO 24h before now', async () => {
    const result = await listDeliverables(buildCtx(), { since: '24h' });
    expect(result.success).toBe(true);
    const gte = capturedGteCalls.find(c => c.column === 'created_at');
    expect(gte?.value).toBe('2026-04-13T00:00:00.000Z');
  });

  it('accepts "7d" and translates to ISO 7 days before now', async () => {
    await listDeliverables(buildCtx(), { since: '7d' });
    const gte = capturedGteCalls.find(c => c.column === 'created_at');
    expect(gte?.value).toBe('2026-04-07T00:00:00.000Z');
  });

  it('accepts "60m" minute shorthand', async () => {
    await listDeliverables(buildCtx(), { since: '60m' });
    const gte = capturedGteCalls.find(c => c.column === 'created_at');
    expect(gte?.value).toBe('2026-04-13T23:00:00.000Z');
  });

  it('accepts an ISO-8601 string passthrough', async () => {
    await listDeliverables(buildCtx(), { since: '2026-03-01T12:30:00Z' });
    const gte = capturedGteCalls.find(c => c.column === 'created_at');
    expect(gte?.value).toBe('2026-03-01T12:30:00.000Z');
  });

  it('omits the filter when since is undefined', async () => {
    await listDeliverables(buildCtx(), {});
    expect(capturedGteCalls.filter(c => c.column === 'created_at')).toHaveLength(0);
  });

  it('rejects malformed since with a structured error instead of silently ignoring it', async () => {
    const result = await listDeliverables(buildCtx(), { since: 'yesterday' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ISO-8601.*relative shorthand/);
  });
});
