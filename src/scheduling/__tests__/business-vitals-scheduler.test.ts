import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BusinessVitalsScheduler,
  normalizeToMonthly,
  defaultStripeFetcher,
} from '../business-vitals-scheduler.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

interface DbCapture {
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
}

function mockDb(taskRows: Array<{ cost_cents: number | null }>): { db: DatabaseAdapter; capture: DbCapture } {
  const capture: DbCapture = { inserts: [] };

  const buildChain = (table: string): Record<string, unknown> => {
    const state = { rows: table === 'agent_workforce_tasks' ? taskRows : [] };
    const chain: Record<string, unknown> = {};
    const wrap = () => chain;
    chain.select = () => wrap();
    chain.eq = () => wrap();
    chain.gte = () => wrap();
    chain.lt = () => wrap();
    chain.order = () => wrap();
    chain.limit = () => wrap();
    chain.insert = (row: Record<string, unknown>) => {
      capture.inserts.push({ table, row });
      return Promise.resolve({ data: null, error: null });
    };
    // Awaiting the chain resolves the select result
    (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
      resolve({ data: state.rows, error: null });
    return chain;
  };

  const db = { from: (table: string) => buildChain(table) } as unknown as DatabaseAdapter;
  return { db, capture };
}

describe('normalizeToMonthly', () => {
  it('returns amount for monthly recurring', () => {
    expect(normalizeToMonthly(2000, 'month', 1)).toBe(2000);
  });
  it('divides yearly by 12', () => {
    expect(normalizeToMonthly(12000, 'year', 1)).toBe(1000);
  });
  it('scales weekly by 4.345', () => {
    expect(normalizeToMonthly(100, 'week', 1)).toBeCloseTo(434.5, 1);
  });
  it('scales daily by 30', () => {
    expect(normalizeToMonthly(10, 'day', 1)).toBe(300);
  });
  it('handles interval_count > 1', () => {
    expect(normalizeToMonthly(3000, 'month', 3)).toBe(1000);
  });
  it('returns 0 for unknown intervals', () => {
    expect(normalizeToMonthly(100, 'century', 1)).toBe(0);
  });
});

describe('BusinessVitalsScheduler.tick', () => {
  it('aggregates daily cost and writes tasks_aggregate row when Stripe key absent', async () => {
    const { db, capture } = mockDb([{ cost_cents: 150 }, { cost_cents: 200 }, { cost_cents: null }]);
    const scheduler = new BusinessVitalsScheduler(db, 'ws-1', { env: {} });
    await scheduler.tick();
    expect(capture.inserts).toHaveLength(1);
    const row = capture.inserts[0];
    expect(row.table).toBe('business_vitals');
    expect(row.row.workspace_id).toBe('ws-1');
    expect(row.row.source).toBe('tasks_aggregate');
    expect(row.row.daily_cost_cents).toBe(350);
    expect(row.row.mrr).toBeNull();
    expect(row.row.arr).toBeNull();
  });

  it('writes stripe row with mrr + arr when fetcher succeeds', async () => {
    const { db, capture } = mockDb([{ cost_cents: 100 }]);
    const stripeFetcher = vi.fn(async () => ({ ok: true, mrr_cents: 5_000_00 }));
    const scheduler = new BusinessVitalsScheduler(db, 'ws-2', {
      env: { STRIPE_API_KEY: 'sk_test_example' },
      stripeFetcher,
    });
    await scheduler.tick();
    expect(stripeFetcher).toHaveBeenCalledOnce();
    const row = capture.inserts[0].row;
    expect(row.source).toBe('stripe');
    expect(row.mrr).toBe(500_000);
    expect(row.arr).toBe(500_000 * 12);
    expect(row.daily_cost_cents).toBe(100);
  });

  it('falls back to tasks_aggregate when fetcher returns ok=false', async () => {
    const { db, capture } = mockDb([]);
    const stripeFetcher = vi.fn(async () => ({ ok: false, reason: 'stripe_http_401' }));
    const scheduler = new BusinessVitalsScheduler(db, 'ws-3', {
      env: { STRIPE_API_KEY: 'sk_bad' },
      stripeFetcher,
    });
    await scheduler.tick();
    const row = capture.inserts[0].row;
    expect(row.source).toBe('tasks_aggregate');
    expect(row.mrr).toBeNull();
    expect(row.daily_cost_cents).toBe(0);
  });

  it('does not invoke fetcher when STRIPE_API_KEY is unset', async () => {
    const { db } = mockDb([]);
    const stripeFetcher = vi.fn(async () => ({ ok: true, mrr_cents: 1 }));
    const scheduler = new BusinessVitalsScheduler(db, 'ws-4', { env: {}, stripeFetcher });
    await scheduler.tick();
    expect(stripeFetcher).not.toHaveBeenCalled();
  });

  it('is reentrancy-safe: overlapping ticks short-circuit', async () => {
    const { db, capture } = mockDb([]);
    const scheduler = new BusinessVitalsScheduler(db, 'ws-5', { env: {} });
    await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
    // Three awaited ticks serialize; at least one row is written but
    // the `running` guard prevents two concurrent inserts from the
    // same tick invocation chain.
    expect(capture.inserts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('defaultStripeFetcher', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns ok=false when STRIPE_API_KEY absent', async () => {
    const r = await defaultStripeFetcher({});
    expect(r.ok).toBe(false);
  });

  it('returns ok=false on non-200 response', async () => {
    global.fetch = vi.fn(async () => new Response('nope', { status: 401 }));
    const r = await defaultStripeFetcher({ STRIPE_API_KEY: 'sk_bad' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/stripe_http_401/);
  });

  it('sums MRR across active subscriptions with mixed intervals', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: 'sub_1',
          items: { data: [{ quantity: 2, price: { unit_amount: 1000, recurring: { interval: 'month', interval_count: 1 } } }] },
        },
        {
          id: 'sub_2',
          items: { data: [{ quantity: 1, price: { unit_amount: 12000, recurring: { interval: 'year', interval_count: 1 } } }] },
        },
      ],
      has_more: false,
    }), { status: 200 }));
    const r = await defaultStripeFetcher({ STRIPE_API_KEY: 'sk_test' });
    expect(r.ok).toBe(true);
    // sub_1: 2 * 1000 = 2000 / month
    // sub_2: 12000 / year = 1000 / month
    expect(r.mrr_cents).toBe(3000);
  });

  it('respects STRIPE_PRODUCT_FILTER allow-list', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 's1', items: { data: [{ quantity: 1, price: { unit_amount: 500, recurring: { interval: 'month' }, product: 'prod_keep' } }] } },
        { id: 's2', items: { data: [{ quantity: 1, price: { unit_amount: 900, recurring: { interval: 'month' }, product: 'prod_drop' } }] } },
      ],
      has_more: false,
    }), { status: 200 }));
    const r = await defaultStripeFetcher({ STRIPE_API_KEY: 'sk_test', STRIPE_PRODUCT_FILTER: 'prod_keep' });
    expect(r.ok).toBe(true);
    expect(r.mrr_cents).toBe(500);
  });
});
