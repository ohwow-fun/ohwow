import { describe, it, expect } from 'vitest';
import { HomeostasisController } from '../homeostasis-controller.js';
import { computeCorrectiveAction } from '../feedback-loops.js';
import { DEFAULT_SET_POINTS } from '../types.js';
import type { SetPoint } from '../types.js';

function makeSetPoint(current: number): SetPoint {
  const defaults = DEFAULT_SET_POINTS.revenue_vs_burn;
  const errorSignal = current - defaults.target;
  return {
    metric: 'revenue_vs_burn',
    target: defaults.target,
    tolerance: defaults.tolerance,
    current,
    errorSignal,
    deviationMagnitude: defaults.target !== 0
      ? Math.min(1, Math.abs(errorSignal) / Math.abs(defaults.target))
      : 0,
    adaptationRate: defaults.adaptationRate,
  };
}

describe('feedback-loops: revenue_vs_burn', () => {
  it('no action within tolerance', () => {
    // target 0.3, tolerance 0.5 → deviation must exceed 0.5 to act.
    // At current=0.3 deviation is 0.
    const a = computeCorrectiveAction(makeSetPoint(0.3));
    expect(a.type).toBe('none');
  });

  it('no action when cost below target (ratio lower than target)', () => {
    const a = computeCorrectiveAction(makeSetPoint(0.1));
    expect(a.type).toBe('none');
  });

  it('throttles when ratio exceeds target beyond tolerance', () => {
    // Build a set point directly so we can force a big deviation
    const sp: SetPoint = {
      metric: 'revenue_vs_burn',
      target: 0.3, tolerance: 0.5, current: 1.0,
      errorSignal: 0.7, deviationMagnitude: 1.0, adaptationRate: 0.05,
    };
    const a = computeCorrectiveAction(sp);
    expect(a.type).toBe('throttle');
    expect(a.urgency).toBeGreaterThan(0);
  });
});

describe('HomeostasisController.getBurnThrottleLevel', () => {
  it('returns 0 by default (pre-revenue workspace)', () => {
    const c = new HomeostasisController(null, 'ws-1');
    expect(c.getBurnThrottleLevel()).toBe(0);
  });

  it('returns 0 when cost is below target ratio', () => {
    const c = new HomeostasisController(null, 'ws-1');
    c.updateMetric('revenue_vs_burn', 0.05);
    expect(c.getBurnThrottleLevel()).toBe(0);
  });

  it('returns 1 when slightly over tolerance', () => {
    const c = new HomeostasisController(null, 'ws-1');
    // target 0.3, tolerance 0.5 (fraction of target = 0.15 absolute).
    // Set deviationMagnitude via current = 0.55 → |0.25|/0.3 = 0.833.
    // urgency = (0.833 - 0.5) / 0.5 = 0.67 → level 2.
    // So use 0.45 instead: |0.15|/0.3 = 0.5 → exactly tolerance → level 0.
    // Use 0.50 for something inside level 1:
    // |0.2|/0.3 = 0.667 → urgency = (0.667 - 0.5)/0.5 = 0.33 → level 1.
    c.updateMetric('revenue_vs_burn', 0.5);
    expect(c.getBurnThrottleLevel()).toBe(1);
  });

  it('returns 2 under severe cost pressure', () => {
    const c = new HomeostasisController(null, 'ws-1');
    c.updateMetric('revenue_vs_burn', 2.0);
    expect(c.getBurnThrottleLevel()).toBe(2);
  });
});
