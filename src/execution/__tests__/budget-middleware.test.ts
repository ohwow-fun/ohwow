/**
 * Budget-middleware threshold tests. Gap 13 (LLM budget enforcement).
 *
 * The four-band chain is the whole policy. These tests are the
 * regression guard: if a future edit slides a band boundary or
 * demotes hardest_reasoning by accident, the failure surfaces here
 * before autonomous spend goes sideways.
 *
 * The meter is stubbed — we don't want a real SQLite in these tests,
 * we want to pin "at N% of cap, the middleware does X" exactly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applyBudgetMiddleware,
  createEmittedTodayTracker,
  BudgetPausedError,
  BudgetExceededError,
  DEGRADE_FALLBACK,
  DEFAULT_AUTONOMOUS_SPEND_LIMIT_USD,
  type BudgetMiddlewareDeps,
  type BudgetPulseEvent,
} from '../budget-middleware.js';
import type { BudgetMeter } from '../budget-meter.js';

function stubMeter(spentUsd: number): BudgetMeter {
  return {
    async getCumulativeAutonomousSpendUsd() {
      return spentUsd;
    },
  };
}

function throwingMeter(): BudgetMeter {
  return {
    async getCumulativeAutonomousSpendUsd() {
      throw new Error('boom: meter exploded');
    },
  };
}

function buildDeps(meter: BudgetMeter, emit?: (e: BudgetPulseEvent) => void): BudgetMiddlewareDeps {
  return {
    meter,
    emittedToday: createEmittedTodayTracker(),
    emitPulse: emit,
  };
}

describe('budget-middleware threshold chain', () => {
  const WS = 'ws-test';
  const LIMIT = 50;
  let events: BudgetPulseEvent[];
  let capturePulse: (e: BudgetPulseEvent) => void;

  beforeEach(() => {
    events = [];
    capturePulse = (e) => events.push(e);
  });

  it('passes through clean with no pulse below 70% of cap', async () => {
    const deps = buildDeps(stubMeter(LIMIT * 0.5), capturePulse);
    const result = await applyBudgetMiddleware(deps, {
      workspaceId: WS,
      limitUsd: LIMIT,
      origin: 'autonomous',
      taskClass: 'agentic_coding',
    });
    expect(result.demoted).toBe(false);
    expect(result.routerDefault.model).toBe('claude-sonnet-4-6');
    expect(result.pulseEvent).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('emits budget.warn pulse exactly once in the 70-85% band', async () => {
    const deps = buildDeps(stubMeter(LIMIT * 0.75), capturePulse);
    const first = await applyBudgetMiddleware(deps, {
      workspaceId: WS,
      limitUsd: LIMIT,
      origin: 'autonomous',
      taskClass: 'agentic_coding',
    });
    expect(first.demoted).toBe(false);
    expect(first.routerDefault.model).toBe('claude-sonnet-4-6');
    expect(first.pulseEvent?.type).toBe('budget.warn');
    expect(events).toHaveLength(1);

    // Second call same day, same workspace: pulse must not fire again.
    const second = await applyBudgetMiddleware(deps, {
      workspaceId: WS,
      limitUsd: LIMIT,
      origin: 'autonomous',
      taskClass: 'agentic_coding',
    });
    expect(second.pulseEvent?.type).toBe('budget.warn'); // event shape still returned
    expect(events).toHaveLength(1); // but emitter fired exactly once
  });

  it('demotes agentic_coding to gemini-3.1-pro in the 85-95% band', async () => {
    const deps = buildDeps(stubMeter(LIMIT * 0.9), capturePulse);
    const result = await applyBudgetMiddleware(deps, {
      workspaceId: WS,
      limitUsd: LIMIT,
      origin: 'autonomous',
      taskClass: 'agentic_coding',
    });
    expect(result.demoted).toBe(true);
    expect(result.routerDefault).toEqual(DEGRADE_FALLBACK);
    expect(result.pulseEvent?.type).toBe('budget.degrade');
    expect(events).toHaveLength(1);
  });

  it('does NOT demote hardest_reasoning in the 85-95% band', async () => {
    const deps = buildDeps(stubMeter(LIMIT * 0.9), capturePulse);
    const result = await applyBudgetMiddleware(deps, {
      workspaceId: WS,
      limitUsd: LIMIT,
      origin: 'autonomous',
      taskClass: 'hardest_reasoning',
    });
    expect(result.demoted).toBe(false);
    // No demote pulse either — the band applies but the class is exempt.
    expect(events).toHaveLength(0);
  });

  it('throws BudgetPausedError in the 95-100% band without bypass', async () => {
    const deps = buildDeps(stubMeter(LIMIT * 0.97), capturePulse);
    await expect(
      applyBudgetMiddleware(deps, {
        workspaceId: WS,
        limitUsd: LIMIT,
        origin: 'autonomous',
        taskClass: 'agentic_coding',
      }),
    ).rejects.toBeInstanceOf(BudgetPausedError);
  });

  it('passes (demoted) in the 95-100% band with bypass=revenue_critical', async () => {
    const deps = buildDeps(stubMeter(LIMIT * 0.97), capturePulse);
    const result = await applyBudgetMiddleware(deps, {
      workspaceId: WS,
      limitUsd: LIMIT,
      origin: 'autonomous',
      taskClass: 'agentic_coding',
      bypass: 'revenue_critical',
    });
    expect(result.demoted).toBe(true);
    expect(result.routerDefault.model).toBe('gemini-3.1-pro');
  });

  it('throws BudgetExceededError at 100%+ even with bypass=revenue_critical', async () => {
    const deps = buildDeps(stubMeter(LIMIT * 1.05), capturePulse);
    await expect(
      applyBudgetMiddleware(deps, {
        workspaceId: WS,
        limitUsd: LIMIT,
        origin: 'autonomous',
        taskClass: 'agentic_coding',
        bypass: 'revenue_critical',
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    await expect(
      applyBudgetMiddleware(deps, {
        workspaceId: WS,
        limitUsd: LIMIT,
        origin: 'autonomous',
        taskClass: 'hardest_reasoning',
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('interactive calls pass through at 100% over cap', async () => {
    const deps = buildDeps(stubMeter(LIMIT * 1.5), capturePulse);
    const result = await applyBudgetMiddleware(deps, {
      workspaceId: WS,
      limitUsd: LIMIT,
      origin: 'interactive',
      taskClass: 'agentic_coding',
    });
    expect(result.demoted).toBe(false);
    expect(result.routerDefault.model).toBe('claude-sonnet-4-6');
  });

  it('fails safe when the meter throws: pass through, log, do not propagate', async () => {
    const deps = buildDeps(throwingMeter(), capturePulse);
    // If this throws the test will fail — the whole point is that a
    // broken meter cannot break a production dispatch.
    const result = await applyBudgetMiddleware(deps, {
      workspaceId: WS,
      limitUsd: LIMIT,
      origin: 'autonomous',
      taskClass: 'agentic_coding',
    });
    expect(result.demoted).toBe(false);
    expect(result.routerDefault.model).toBe('claude-sonnet-4-6');
  });

  it('falls back to DEFAULT_AUTONOMOUS_SPEND_LIMIT_USD when limit is unset', async () => {
    // 99% of the $50 default = $49.50, inside the pause band, no bypass.
    const deps = buildDeps(stubMeter(DEFAULT_AUTONOMOUS_SPEND_LIMIT_USD * 0.99), capturePulse);
    await expect(
      applyBudgetMiddleware(deps, {
        workspaceId: WS,
        origin: 'autonomous',
        taskClass: 'agentic_coding',
      }),
    ).rejects.toBeInstanceOf(BudgetPausedError);
  });

  it('error messages avoid em/en dashes and "Failed to" phrasing', async () => {
    const pauseErr = new BudgetPausedError(WS, 48, 50);
    const hardErr = new BudgetExceededError(WS, 55, 50);
    for (const e of [pauseErr, hardErr]) {
      expect(e.message).not.toMatch(/—|–/);
      expect(e.message).not.toMatch(/^Failed to /i);
    }
  });

  it('fires a budget.pause pulse exactly once before throwing BudgetPausedError', async () => {
    const deps = buildDeps(stubMeter(LIMIT * 0.96), capturePulse);
    await expect(
      applyBudgetMiddleware(deps, {
        workspaceId: WS,
        limitUsd: LIMIT,
        origin: 'autonomous',
        taskClass: 'agentic_coding',
      }),
    ).rejects.toBeInstanceOf(BudgetPausedError);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('budget.pause');

    // A second autonomous call on the same day must still throw but
    // must NOT double-fire the pause pulse (idempotency guard so a
    // stuck autonomous loop cannot spam the operator toast).
    await expect(
      applyBudgetMiddleware(deps, {
        workspaceId: WS,
        limitUsd: LIMIT,
        origin: 'autonomous',
        taskClass: 'bulk_cost_sensitive',
      }),
    ).rejects.toBeInstanceOf(BudgetPausedError);
    expect(events).toHaveLength(1);
  });

  it('fires a budget.halt pulse exactly once before throwing BudgetExceededError', async () => {
    const deps = buildDeps(stubMeter(LIMIT * 1.05), capturePulse);
    await expect(
      applyBudgetMiddleware(deps, {
        workspaceId: WS,
        limitUsd: LIMIT,
        origin: 'autonomous',
        taskClass: 'agentic_coding',
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('budget.halt');

    // Second autonomous call over the cap: still throws, pulse
    // does not double-fire.
    await expect(
      applyBudgetMiddleware(deps, {
        workspaceId: WS,
        limitUsd: LIMIT,
        origin: 'autonomous',
        taskClass: 'hardest_reasoning',
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(events).toHaveLength(1);
  });

  it('does not fire a pause pulse when bypass=revenue_critical escapes the 95-100% band', async () => {
    // When the caller opts out of the pause via bypass, the call goes
    // through (demoted), which means no operator notification should
    // fire for a pause that never happened. The pulse tracks the
    // OPERATOR-VISIBLE transition, not the utilization number.
    const deps = buildDeps(stubMeter(LIMIT * 0.97), capturePulse);
    const result = await applyBudgetMiddleware(deps, {
      workspaceId: WS,
      limitUsd: LIMIT,
      origin: 'autonomous',
      taskClass: 'agentic_coding',
      bypass: 'revenue_critical',
    });
    expect(result.demoted).toBe(true);
    expect(events).toHaveLength(0);
  });
});

describe('budget-middleware meter-error isolation (detailed)', () => {
  it('swallows meter errors and does not re-throw, even at the boundary between bands', async () => {
    // Even if a future edit tries to "helpfully" fall through to the
    // hard-halt branch when the meter is broken, this test keeps the
    // fail-safe contract honest: spend=0 on meter failure, so no
    // band transition fires.
    const warnSpy = vi.fn();
    const deps = buildDeps(throwingMeter(), warnSpy);
    const result = await applyBudgetMiddleware(deps, {
      workspaceId: 'ws-x',
      limitUsd: 10,
      origin: 'autonomous',
      taskClass: 'bulk_cost_sensitive',
    });
    expect(result.demoted).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
