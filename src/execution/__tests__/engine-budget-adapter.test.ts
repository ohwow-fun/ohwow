/**
 * Engine budget-adapter tests. Gap 13 follow-up round (scheduler-driven
 * callers). `RuntimeEngine.getAutonomousBudgetDeps()` is the single
 * accessor every scheduler-driven autonomous caller
 * (x-post-draft-generator, reply-copy-generator, synthesis-generator,
 * x-draft-distiller, reflection consolidator, self-bench experiment
 * authors) uses to enroll its `runLlmCall` in the per-workspace daily
 * cap + operator toasts. These tests pin the shape the helper returns
 * so a future edit cannot silently drop the meter, notifier, or
 * `origin: 'autonomous'` stamp.
 */

import { describe, it, expect } from 'vitest';
import { RuntimeEngine } from '../engine.js';
import { createEmittedTodayTracker, type BudgetPulseEvent } from '../budget-middleware.js';
import type { BudgetMeter } from '../budget-meter.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { EngineConfig, RuntimeEffects, BusinessContext } from '../types.js';

function makeEngine(): RuntimeEngine {
  const db = {} as DatabaseAdapter;
  const config = { dataDir: '/tmp/ohwow-test', browserHeadless: true } as EngineConfig;
  const effects = {} as RuntimeEffects;
  const businessContext = {} as BusinessContext;
  return new RuntimeEngine(db, config, effects, businessContext);
}

function makeMeter(): BudgetMeter {
  return {
    async getCumulativeAutonomousSpendUsd() {
      return 0;
    },
  };
}

describe('RuntimeEngine.getAutonomousBudgetDeps', () => {
  it('returns undefined before setBudgetDeps has run', () => {
    const engine = makeEngine();
    expect(engine.getAutonomousBudgetDeps()).toBeUndefined();
  });

  it('returns the wired meter, tracker, emitter, limit, and autonomous origin after setBudgetDeps', () => {
    const engine = makeEngine();
    const meter = makeMeter();
    const emittedToday = createEmittedTodayTracker();
    const emitPulse = (_e: BudgetPulseEvent) => {
      /* no-op for this shape check */
    };
    engine.setBudgetDeps({ meter, emittedToday, emitPulse }, 42);

    const deps = engine.getAutonomousBudgetDeps();
    expect(deps).toBeDefined();
    expect(deps!.meter).toBe(meter);
    expect(deps!.emittedToday).toBe(emittedToday);
    expect(deps!.emitPulse).toBe(emitPulse);
    expect(deps!.limitUsd).toBe(42);
    expect(deps!.origin).toBe('autonomous');
  });

  it('returns undefined again after setBudgetDeps(null) — graceful shutdown path', () => {
    const engine = makeEngine();
    engine.setBudgetDeps(
      { meter: makeMeter(), emittedToday: createEmittedTodayTracker() },
      10,
    );
    expect(engine.getAutonomousBudgetDeps()).toBeDefined();

    engine.setBudgetDeps(null);
    expect(engine.getAutonomousBudgetDeps()).toBeUndefined();
  });

  it('omits limitUsd on the payload when the daemon did not configure a cap override', () => {
    const engine = makeEngine();
    engine.setBudgetDeps({ meter: makeMeter(), emittedToday: createEmittedTodayTracker() });
    const deps = engine.getAutonomousBudgetDeps();
    expect(deps).toBeDefined();
    expect(deps!.limitUsd).toBeUndefined();
    // The middleware substitutes DEFAULT_AUTONOMOUS_SPEND_LIMIT_USD when
    // limitUsd is absent, so the omission is load-bearing.
  });
});
