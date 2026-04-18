/**
 * Budget-meter tests. Gap 13 (LLM budget enforcement).
 *
 * These tests pin the meter's SELECT shape so the origin filter added
 * in migration 141 never silently regresses. An interactive-tagged row
 * MUST NOT count against the autonomous daily cap: if it ever does, the
 * cap starts tripping on operator-initiated spend, which was the bug
 * this round closed.
 *
 * The DatabaseAdapter is stubbed with a chainable fake so the test
 * stays in-memory — no SQLite, no fixtures. The fake records every
 * filter the meter applied so we can assert origin='autonomous' landed
 * on the query alongside the workspace + created_at bounds.
 */
import { describe, it, expect } from 'vitest';

import { createBudgetMeter, utcMidnightIso } from '../budget-meter.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

interface LlmCallRow {
  workspace_id: string;
  origin: 'autonomous' | 'interactive';
  cost_cents: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

/**
 * Fake adapter scoped to the llm_calls table. Applies chained filters
 * in-memory so the meter sees a realistic "data shape matches the
 * filters you asked for" result. Other tables throw — the meter should
 * never touch them.
 */
function fakeAdapter(rows: LlmCallRow[]): { db: DatabaseAdapter; lastEqFilters: Array<[string, unknown]> } {
  const lastEqFilters: Array<[string, unknown]> = [];

  // Minimal chainable builder. Returns `this`-typed objects so the
  // meter's .from(...).select().eq().eq().gte() chain resolves without
  // needing the full FilterBuilder surface.
  const db: DatabaseAdapter = {
    from<T = Record<string, unknown>>(table: string) {
      if (table !== 'llm_calls') {
        throw new Error(`fakeAdapter: unexpected table ${table}`);
      }
      let filtered = [...rows];
      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          lastEqFilters.push([column, value]);
          filtered = filtered.filter((r) => (r as unknown as Record<string, unknown>)[column] === value);
          return builder;
        },
        gte(column: string, value: unknown) {
          filtered = filtered.filter(
            (r) => String((r as unknown as Record<string, unknown>)[column]) >= String(value),
          );
          return builder;
        },
        then<R>(resolve: (v: { data: T[]; error: null }) => R): R {
          return resolve({ data: filtered as unknown as T[], error: null });
        },
      };
      return builder as never;
    },
    rpc: () => { throw new Error('fakeAdapter: rpc not supported in tests'); },
  };
  return { db, lastEqFilters };
}

describe('createBudgetMeter: origin filter', () => {
  const WS = 'ws-1';
  const NOW = Date.parse('2026-04-17T14:00:00Z');
  const TODAY = utcMidnightIso(NOW);

  it('excludes interactive rows from the cumulative autonomous sum', async () => {
    const { db, lastEqFilters } = fakeAdapter([
      // 300¢ autonomous — counted.
      { workspace_id: WS, origin: 'autonomous', cost_cents: 300, model: 'claude-sonnet-4-6', input_tokens: 0, output_tokens: 0, created_at: TODAY },
      // 900¢ interactive — MUST NOT be counted.
      { workspace_id: WS, origin: 'interactive', cost_cents: 900, model: 'claude-sonnet-4-6', input_tokens: 0, output_tokens: 0, created_at: TODAY },
      // 150¢ autonomous — counted.
      { workspace_id: WS, origin: 'autonomous', cost_cents: 150, model: 'claude-sonnet-4-6', input_tokens: 0, output_tokens: 0, created_at: TODAY },
    ]);
    const meter = createBudgetMeter(db);
    const spent = await meter.getCumulativeAutonomousSpendUsd(WS, NOW);

    // 300¢ + 150¢ = 450¢ = $4.50. If the 900¢ interactive row leaked
    // into the sum this would be $13.50.
    expect(spent).toBeCloseTo(4.5, 2);

    // The query must have filtered by both workspace_id and origin.
    // Pinning these stops a future edit from dropping the origin eq
    // and silently re-counting interactive spend.
    expect(lastEqFilters).toContainEqual(['workspace_id', WS]);
    expect(lastEqFilters).toContainEqual(['origin', 'autonomous']);
  });

  it('keeps the estimateCostUsdCents fallback intact for cost_cents=0 rows', async () => {
    const { db } = fakeAdapter([
      // cost_cents=0 but tokens present — the meter should price it via
      // PRICING_USD_PER_MTOK. claude-sonnet-4-6 = $3/MTok prompt, so
      // 1_000_000 input tokens = $3 = 300¢.
      { workspace_id: WS, origin: 'autonomous', cost_cents: 0, model: 'claude-sonnet-4-6', input_tokens: 1_000_000, output_tokens: 0, created_at: TODAY },
    ]);
    const meter = createBudgetMeter(db);
    const spent = await meter.getCumulativeAutonomousSpendUsd(WS, NOW);
    expect(spent).toBeCloseTo(3.0, 2);
  });
});
