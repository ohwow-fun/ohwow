import { describe, it, expect } from 'vitest';
import { decideStrategy } from '../experiments/strategist.js';

describe('decideStrategy', () => {
  it('steady state — no backlog, no patch-loop data, no burn', () => {
    const d = decideStrategy({
      topFailing: [],
      patchLoop: null,
      burn: null,
      reflectionCount: 0,
    });
    expect(d.priority_experiments).toEqual([]);
    expect(d.demoted_experiments).toEqual([]);
    expect(d.active_focus).toMatch(/steady state/);
  });

  it('prioritizes the top-3 most-failing experiments', () => {
    const d = decideStrategy({
      topFailing: [
        { experimentId: 'dashboard-copy', count: 297 },
        { experimentId: 'patch-loop-health', count: 243 },
        { experimentId: 'ledger-health', count: 101 },
        { experimentId: 'dashboard-smoke', count: 61 },
      ],
      patchLoop: null,
      burn: null,
      reflectionCount: 0,
    });
    expect(d.priority_experiments.slice(0, 3)).toEqual([
      'dashboard-copy',
      'patch-loop-health',
      'ledger-health',
    ]);
    expect(d.active_focus).toMatch(/dashboard-copy/);
  });

  it('biases toward patch-author when hold_rate < 0.5 and pool growing', () => {
    const d = decideStrategy({
      topFailing: [{ experimentId: 'dashboard-copy', count: 100 }],
      patchLoop: { holdRate: 0.38, poolDelta: 464 },
      burn: null,
      reflectionCount: 0,
    });
    expect(d.priority_experiments[0]).toBe('patch-author');
    expect(d.priority_experiments).toContain('autonomous-patch-rollback');
    expect(d.demoted_experiments).toContain('experiment-author');
    expect(d.active_focus).toMatch(/losing/);
  });

  it('widens patch-author when hold_rate healthy but pool growing', () => {
    const d = decideStrategy({
      topFailing: [],
      patchLoop: { holdRate: 0.9, poolDelta: 50 },
      burn: null,
      reflectionCount: 0,
    });
    expect(d.priority_experiments[0]).toBe('patch-author');
    expect(d.demoted_experiments).not.toContain('experiment-author');
    expect(d.active_focus).toMatch(/behind/);
  });

  it('under burn pressure (ratio > 1), demotes LLM-heavy experiments', () => {
    const d = decideStrategy({
      topFailing: [],
      patchLoop: null,
      burn: { ratio: 1.4 },
      reflectionCount: 0,
    });
    expect(d.demoted_experiments).toContain('experiment-author');
    expect(d.demoted_experiments).toContain('patch-author');
    expect(d.active_focus).toMatch(/burn ratio/);
    expect(d.priority_experiments).not.toContain('patch-author');
  });

  it('does NOT demote for burn when ratio below 1', () => {
    const d = decideStrategy({
      topFailing: [],
      patchLoop: { holdRate: 0.3, poolDelta: 100 },
      burn: { ratio: 0.5 },
      reflectionCount: 0,
    });
    expect(d.demoted_experiments).not.toContain('patch-author');
    expect(d.priority_experiments).toContain('patch-author');
  });

  it('dedups priority list when patch-loop adds already-top experiments', () => {
    const d = decideStrategy({
      topFailing: [{ experimentId: 'patch-author', count: 50 }],
      patchLoop: { holdRate: 0.3, poolDelta: 100 },
      burn: null,
      reflectionCount: 0,
    });
    const n = d.priority_experiments.filter((x) => x === 'patch-author').length;
    expect(n).toBe(1);
  });

  it('combines all three signals cleanly (backlog + losing + burn)', () => {
    const d = decideStrategy({
      topFailing: [
        { experimentId: 'dashboard-copy', count: 300 },
        { experimentId: 'ledger-health', count: 100 },
      ],
      patchLoop: { holdRate: 0.3, poolDelta: 500 },
      burn: { ratio: 1.2 },
      reflectionCount: 3,
    });
    // Burn forces patch-author OUT of priority
    expect(d.priority_experiments).not.toContain('patch-author');
    // dashboard-copy (biggest backlog) stays on priority
    expect(d.priority_experiments).toContain('dashboard-copy');
    // Both experiment-author and patch-author demoted
    expect(d.demoted_experiments).toContain('experiment-author');
    expect(d.demoted_experiments).toContain('patch-author');
  });

  it('flags overweight_models when one cloud model eats >70% of spend and local<20%', () => {
    const d = decideStrategy({
      topFailing: [],
      patchLoop: null,
      burn: null,
      burnConcentration: {
        topModel: 'xiaomi/mimo-v2-flash',
        topModelShare: 0.86,
        localCallRatio: 0,
        totalCentsToday: 967,
      },
      reflectionCount: 0,
    });
    expect(d.overweight_models).toEqual(['xiaomi/mimo-v2-flash']);
    expect(d.demoted_experiments).toContain('experiment-author');
    expect(d.active_focus).toMatch(/concentrated/);
  });

  it('does not flag concentration when local ratio is healthy', () => {
    const d = decideStrategy({
      topFailing: [],
      patchLoop: null,
      burn: null,
      burnConcentration: {
        topModel: 'xiaomi/mimo-v2-flash',
        topModelShare: 0.86,
        localCallRatio: 0.5,
        totalCentsToday: 967,
      },
      reflectionCount: 0,
    });
    expect(d.overweight_models).toEqual([]);
  });

  it('does not flag concentration on trivial spend days', () => {
    const d = decideStrategy({
      topFailing: [],
      patchLoop: null,
      burn: null,
      burnConcentration: {
        topModel: 'xiaomi/mimo-v2-flash',
        topModelShare: 0.9,
        localCallRatio: 0,
        totalCentsToday: 20,
      },
      reflectionCount: 0,
    });
    expect(d.overweight_models).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Phase 5c — lift-health signal
  // ---------------------------------------------------------------------------

  it('demotes patch-author when 7d lift has a clear regression pattern', () => {
    const d = decideStrategy({
      topFailing: [],
      patchLoop: { holdRate: 0.9, poolDelta: -10 },
      burn: null,
      reflectionCount: 0,
      liftHealth: {
        moved_right: 1,
        moved_wrong: 6,
        flat: 1,
        unmeasured: 0,
        total_closed: 8,
        window_hours: 168,
      },
    });
    expect(d.demoted_experiments).toContain('patch-author');
    expect(d.active_focus).toMatch(/lift regression/);
  });

  it('ignores lift signal when below the min-sample floor', () => {
    const d = decideStrategy({
      topFailing: [],
      patchLoop: null,
      burn: null,
      reflectionCount: 0,
      liftHealth: {
        moved_right: 0,
        moved_wrong: 2,
        flat: 0,
        unmeasured: 0,
        total_closed: 2, // below the 5-sample floor
        window_hours: 168,
      },
    });
    expect(d.demoted_experiments).not.toContain('patch-author');
    expect(d.active_focus).not.toMatch(/lift regression/);
  });

  it('does NOT demote when lift is healthy (moved_right dominant)', () => {
    const d = decideStrategy({
      topFailing: [],
      patchLoop: null,
      burn: null,
      reflectionCount: 0,
      liftHealth: {
        moved_right: 7,
        moved_wrong: 1,
        flat: 2,
        unmeasured: 0,
        total_closed: 10,
        window_hours: 168,
      },
    });
    expect(d.demoted_experiments).not.toContain('patch-author');
    expect(d.active_focus).toMatch(/steady state/);
  });

  it('does NOT demote on mixed-but-near-balanced lift (net ratio > -0.2)', () => {
    const d = decideStrategy({
      topFailing: [],
      patchLoop: null,
      burn: null,
      reflectionCount: 0,
      liftHealth: {
        moved_right: 4,
        moved_wrong: 5,
        flat: 1,
        unmeasured: 0,
        total_closed: 10, // net ratio = -0.1
        window_hours: 168,
      },
    });
    expect(d.demoted_experiments).not.toContain('patch-author');
  });

  it('lift regression removes patch-author from priority too, not just adds to demoted', () => {
    const d = decideStrategy({
      topFailing: [],
      // hold_rate healthy but pool growing would normally put patch-author on priority
      patchLoop: { holdRate: 0.9, poolDelta: 20 },
      burn: null,
      reflectionCount: 0,
      liftHealth: {
        moved_right: 1,
        moved_wrong: 7,
        flat: 0,
        unmeasured: 0,
        total_closed: 8,
        window_hours: 168,
      },
    });
    // patch-author must NOT be on priority while lift is regressing
    expect(d.priority_experiments).not.toContain('patch-author');
    expect(d.demoted_experiments).toContain('patch-author');
  });
});
