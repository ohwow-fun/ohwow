import { describe, it, expect, beforeEach } from 'vitest';
import { initializeSetPoints, updateSetPoint, adaptSetPoint } from '../set-points.js';
import { computeCorrectiveAction, computeAllCorrectiveActions } from '../feedback-loops.js';
import { HomeostasisController } from '../homeostasis-controller.js';
import type { SetPoint } from '../types.js';

describe('set-points', () => {
  it('should initialize all default set points', () => {
    const sps = initializeSetPoints();
    expect(sps.length).toBeGreaterThanOrEqual(5);
    expect(sps.every(sp => sp.errorSignal === 0)).toBe(true);
  });

  it('should compute error signal on update', () => {
    const sp = initializeSetPoints().find(s => s.metric === 'success_rate')!;
    const updated = updateSetPoint(sp, 0.5); // below target of 0.8
    expect(updated.errorSignal).toBeLessThan(0);
    expect(updated.deviationMagnitude).toBeGreaterThan(0);
  });

  it('should adapt set point toward current when persistent', () => {
    const sp: SetPoint = {
      metric: 'cost_per_day',
      target: 50,
      tolerance: 0.3,
      current: 80,
      errorSignal: 30,
      deviationMagnitude: 0.6,
      adaptationRate: 0.1,
    };
    const adapted = adaptSetPoint(sp, true);
    expect(adapted.target).toBeGreaterThan(50); // shifted toward 80
    expect(adapted.target).toBeLessThan(80);    // but not all the way
  });

  it('should not adapt when not persistent', () => {
    const sp: SetPoint = {
      metric: 'cost_per_day',
      target: 50,
      tolerance: 0.3,
      current: 80,
      errorSignal: 30,
      deviationMagnitude: 0.6,
      adaptationRate: 0.1,
    };
    const notAdapted = adaptSetPoint(sp, false);
    expect(notAdapted.target).toBe(50);
  });
});

describe('feedback-loops', () => {
  it('should return none when within tolerance', () => {
    const sp: SetPoint = {
      metric: 'success_rate',
      target: 0.8,
      tolerance: 0.15,
      current: 0.75,
      errorSignal: -0.05,
      deviationMagnitude: 0.0625,
      adaptationRate: 0.05,
    };
    const action = computeCorrectiveAction(sp);
    expect(action.type).toBe('none');
  });

  it('should throttle when cost exceeds target', () => {
    const sp: SetPoint = {
      metric: 'cost_per_day',
      target: 50,
      tolerance: 0.3,
      current: 100,
      errorSignal: 50,
      deviationMagnitude: 1.0,
      adaptationRate: 0.1,
    };
    const action = computeCorrectiveAction(sp);
    expect(action.type).toBe('throttle');
    expect(action.urgency).toBeGreaterThan(0);
  });

  it('should suggest memory compression when memory high', () => {
    const sp: SetPoint = {
      metric: 'memory_count',
      target: 500,
      tolerance: 0.4,
      current: 900,
      errorSignal: 400,
      deviationMagnitude: 0.8,
      adaptationRate: 0.05,
    };
    const action = computeCorrectiveAction(sp);
    expect(action.type).toBe('compress_memory');
  });

  it('should suggest routing adjustment when success rate low', () => {
    const sp: SetPoint = {
      metric: 'success_rate',
      target: 0.8,
      tolerance: 0.15,
      current: 0.4,
      errorSignal: -0.4,
      deviationMagnitude: 0.5,
      adaptationRate: 0.05,
    };
    const action = computeCorrectiveAction(sp);
    expect(action.type).toBe('adjust_routing');
  });

  it('should sort actions by urgency', () => {
    const setPoints: SetPoint[] = [
      { metric: 'success_rate', target: 0.8, tolerance: 0.15, current: 0.3, errorSignal: -0.5, deviationMagnitude: 0.625, adaptationRate: 0.05 },
      { metric: 'cost_per_day', target: 50, tolerance: 0.3, current: 200, errorSignal: 150, deviationMagnitude: 1.0, adaptationRate: 0.1 },
    ];
    const actions = computeAllCorrectiveActions(setPoints);
    expect(actions.length).toBe(2);
    expect(actions[0].urgency).toBeGreaterThanOrEqual(actions[1].urgency);
  });
});

describe('HomeostasisController', () => {
  let controller: HomeostasisController;

  beforeEach(() => {
    controller = new HomeostasisController(null, 'test-workspace');
  });

  it('should start with no deviations', () => {
    const state = controller.check();
    expect(state.overallDeviation).toBe(0);
    expect(state.correctiveActions.length).toBe(0);
  });

  it('should detect deviation after metric update', () => {
    controller.updateMetric('success_rate', 0.3); // way below target 0.8
    const state = controller.check();
    expect(state.correctiveActions.length).toBeGreaterThan(0);
    expect(state.correctiveActions[0].metric).toBe('success_rate');
  });

  it('should return null prompt context when balanced', () => {
    expect(controller.buildPromptContext()).toBeNull();
  });

  it('should return prompt context when deviating', () => {
    controller.updateMetric('cost_per_day', 200);
    const ctx = controller.buildPromptContext();
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('cost_per_day');
  });

  it('should run allostasis when deviation is persistent', async () => {
    // Feed 15 readings of high memory count
    for (let i = 0; i < 15; i++) {
      controller.updateMetric('memory_count', 900);
    }
    await controller.runAllostasis();
    // Should have adapted memory_count target upward
    const sp = controller.getSetPoint('memory_count');
    expect(sp!.target).toBeGreaterThan(500); // original target
  });

  it('should not adapt with insufficient data', async () => {
    controller.updateMetric('memory_count', 900);
    const events = await controller.runAllostasis();
    expect(events.length).toBe(0); // not enough history
  });

  it('should report overall deviation', () => {
    controller.updateMetric('success_rate', 0.3);
    controller.updateMetric('cost_per_day', 200);
    const deviation = controller.getOverallDeviation();
    expect(deviation).toBeGreaterThan(0);
  });
});
