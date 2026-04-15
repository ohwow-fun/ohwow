import { describe, it, expect } from 'vitest';
import {
  computeRevenueVsBurnRatio,
  HomeostasisController,
} from '../homeostasis-controller.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

describe('computeRevenueVsBurnRatio', () => {
  it('returns 0 when MRR absent', () => {
    expect(computeRevenueVsBurnRatio(null, 500)).toBe(0);
    expect(computeRevenueVsBurnRatio(0, 500)).toBe(0);
  });
  it('returns 0 when cost absent', () => {
    expect(computeRevenueVsBurnRatio(30_000, null)).toBe(0);
    expect(computeRevenueVsBurnRatio(30_000, 0)).toBe(0);
  });
  it('is cost_per_day / (mrr/30)', () => {
    // mrr 30,000c => 1,000c/day. cost 500c => ratio 0.5
    expect(computeRevenueVsBurnRatio(30_000, 500)).toBe(0.5);
  });
  it('clamps runaway ratios at 5', () => {
    expect(computeRevenueVsBurnRatio(30_000, 1_000_000)).toBe(5);
  });
});

describe('HomeostasisController.refreshBusinessVitals', () => {
  function makeDb(row: { mrr: number | null; daily_cost_cents: number | null } | null): DatabaseAdapter {
    const chain: Record<string, unknown> = {};
    const wrap = () => chain;
    chain.select = () => wrap();
    chain.eq = () => wrap();
    chain.order = () => wrap();
    chain.limit = () => wrap();
    (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
      resolve({ data: row ? [row] : [], error: null });
    return { from: () => chain } as unknown as DatabaseAdapter;
  }

  it('updates revenue_vs_burn from latest row', async () => {
    const controller = new HomeostasisController(
      makeDb({ mrr: 60_000, daily_cost_cents: 1000 }),
      'ws-1',
    );
    await controller.refreshBusinessVitals();
    const sp = controller.getSetPoint('revenue_vs_burn');
    // mrr 60,000 / 30 = 2000/day, cost 1000/day => ratio 0.5
    expect(sp?.current).toBe(0.5);
  });

  it('is a no-op when there are no rows', async () => {
    const controller = new HomeostasisController(makeDb(null), 'ws-1');
    await controller.refreshBusinessVitals();
    const sp = controller.getSetPoint('revenue_vs_burn');
    // Untouched — still at default target
    expect(sp?.current).toBe(sp?.target);
  });
});
