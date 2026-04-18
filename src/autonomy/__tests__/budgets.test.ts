/**
 * Per-mode budget constants (gap 14.11b).
 *
 * Pinned values — guards against accidental edits to wall_minutes /
 * llm_cents / demotion knobs that ripple through Director enforcement
 * and Ranker demotion semantics. Touching these constants is a real
 * policy change; the test must be updated alongside the constant edit.
 */

import { describe, it, expect } from 'vitest';
import {
  MODE_BUDGETS,
  DEMOTION_MULTIPLIER,
  DEMOTION_LOOKBACK_ARCS,
  DEMOTION_OVERAGE_RATIO,
} from '../budgets.js';

describe('MODE_BUDGETS', () => {
  it('pins wall_minutes + llm_cents per mode', () => {
    expect(MODE_BUDGETS).toEqual({
      revenue: { wall_minutes: 15, llm_cents: 10 },
      polish: { wall_minutes: 90, llm_cents: 50 },
      plumbing: { wall_minutes: 120, llm_cents: 30 },
      tooling: { wall_minutes: 180, llm_cents: 100 },
    });
  });

  it('covers every Mode key', () => {
    // Compile-time + runtime: every mode must have a budget. If a new
    // mode is added to types.ts, this assertion forces a budget entry.
    const modes = Object.keys(MODE_BUDGETS).sort();
    expect(modes).toEqual(['plumbing', 'polish', 'revenue', 'tooling']);
  });
});

describe('demotion knobs', () => {
  it('DEMOTION_MULTIPLIER is 0.7 (30% score haircut)', () => {
    expect(DEMOTION_MULTIPLIER).toBe(0.7);
  });

  it('DEMOTION_LOOKBACK_ARCS is 3 (averages last 3 distinct arcs)', () => {
    expect(DEMOTION_LOOKBACK_ARCS).toBe(3);
  });

  it('DEMOTION_OVERAGE_RATIO is 1.5 (avg must blow cap by >=50%)', () => {
    expect(DEMOTION_OVERAGE_RATIO).toBe(1.5);
  });
});
