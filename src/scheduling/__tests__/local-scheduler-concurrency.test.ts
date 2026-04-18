/**
 * Concurrency cap tests for LocalScheduler's automation-schedule dispatch.
 *
 * Commit 3 added a per-profile mutex + atomic tab claims so browser automation
 * within a single profile serializes. This cap (commit 4) complements it with
 * a global ceiling: when a burst of schedules comes due, only N run in parallel
 * across profiles; overflow defers to the next tick. Prevents CDP/CPU flooding
 * that destabilized Chrome when ~10 automations fired simultaneously.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalScheduler } from '../local-scheduler.js';
import { mockDb, mockEngine } from '../../__tests__/helpers/mock-db.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { RuntimeEngine } from '../../execution/engine.js';

// cron-parser mock: every row computes prev() = now - 60s, so every row is past-due
// when last_fired_at is null (scheduler reads prev() in that branch).
vi.mock('cron-parser', () => {
  const makeDateObj = (d: Date) => ({ toISOString: () => d.toISOString() });
  return {
    CronExpressionParser: {
      parse: vi.fn((_cron: string, opts?: { currentDate?: Date }) => {
        const ref = opts?.currentDate ?? new Date();
        return {
          next: () => makeDateObj(new Date(ref.getTime() + 60_000)),
          prev: () => makeDateObj(new Date(ref.getTime() - 60_000)),
        };
      }),
    },
  };
});

vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

type Trigger = {
  id: string;
  name: string;
  trigger_type: string;
  trigger_config: string;
  enabled: number;
  last_fired_at: string | null;
};

function makePastDueTriggers(count: number): Trigger[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `trig-${i}`,
    name: `trig-${i}`,
    trigger_type: 'schedule',
    trigger_config: JSON.stringify({ cron: '* * * * *' }),
    enabled: 1,
    last_fired_at: null,
  }));
}

/** Build a scheduler wired up with an evaluator that we control via a deferred promise. */
function setup(triggers: Trigger[]) {
  const db = mockDb({
    agent_workforce_schedules: { data: [] },
    local_triggers: { data: triggers },
  }) as unknown as DatabaseAdapter;
  const engine = { ...mockEngine } as unknown as RuntimeEngine;
  const scheduler = new LocalScheduler(db, engine, 'ws-test');

  // Deferred-promise evaluator: executeById returns a promise we can resolve on demand.
  const pending = new Map<string, { resolve: () => void; reject: (err: unknown) => void }>();
  const executeById = vi.fn().mockImplementation((id: string) => {
    return new Promise<void>((resolve, reject) => {
      pending.set(id, { resolve: () => resolve(), reject });
    });
  });
  scheduler.setTriggerEvaluator({ executeById } as any);

  return { scheduler, db, engine, executeById, pending };
}

describe('LocalScheduler — automation concurrency cap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    delete process.env.OHWOW_AUTOMATION_CONCURRENCY;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.OHWOW_AUTOMATION_CONCURRENCY;
  });

  it('starts at most `cap` automations per tick when more are due', async () => {
    process.env.OHWOW_AUTOMATION_CONCURRENCY = '2';
    const { scheduler, executeById } = setup(makePastDueTriggers(5));

    await scheduler.start();

    // Exactly 2 started; the other 3 were deferred (break taken).
    expect(executeById).toHaveBeenCalledTimes(2);
    expect(executeById).toHaveBeenNthCalledWith(1, 'trig-0');
    expect(executeById).toHaveBeenNthCalledWith(2, 'trig-1');

    scheduler.stop();
  });

  it('allows more to start on the next tick once running ones settle', async () => {
    process.env.OHWOW_AUTOMATION_CONCURRENCY = '2';
    const { scheduler, executeById, pending } = setup(makePastDueTriggers(5));

    await scheduler.start();
    expect(executeById).toHaveBeenCalledTimes(2);

    // Resolve both in-flight automations; wait for the finally() microtask
    // to drain the running set.
    pending.get('trig-0')!.resolve();
    pending.get('trig-1')!.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Re-invoke the automation-dispatch path directly (avoids advancing fake
    // timers, which would recursively fire the setTimeout(tick,0) that
    // recalculate() queues when any schedule is past-due and cause unbounded
    // re-entry in this mock setup).
    await (scheduler as unknown as {
      tickAutomationSchedules(now: string): Promise<void>;
    }).tickAutomationSchedules(new Date().toISOString());

    // A fresh dispatch picks up 2 more of the still-past-due tail.
    expect(executeById.mock.calls.length).toBe(4);

    scheduler.stop();
  });

  it('removes a failed automation from the running set (errors do not leak slots)', async () => {
    process.env.OHWOW_AUTOMATION_CONCURRENCY = '2';
    const { scheduler, executeById, pending } = setup(makePastDueTriggers(3));

    await scheduler.start();
    expect(executeById).toHaveBeenCalledTimes(2);

    // Fail both in-flight; the finally() cleanup must still run.
    pending.get('trig-0')!.reject(new Error('boom'));
    pending.get('trig-1')!.reject(new Error('boom'));
    await Promise.resolve();
    await Promise.resolve();

    // Running set should be empty again — verify via scheduler internals.
    expect((scheduler as unknown as { runningAutomations: Set<unknown> }).runningAutomations.size).toBe(0);

    scheduler.stop();
  });

  it('defaults to cap=3 when OHWOW_AUTOMATION_CONCURRENCY is unset', async () => {
    delete process.env.OHWOW_AUTOMATION_CONCURRENCY;
    const { scheduler, executeById } = setup(makePastDueTriggers(10));

    await scheduler.start();

    expect(executeById).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it('honors OHWOW_AUTOMATION_CONCURRENCY when set', async () => {
    process.env.OHWOW_AUTOMATION_CONCURRENCY = '5';
    const { scheduler, executeById } = setup(makePastDueTriggers(10));

    await scheduler.start();

    expect(executeById).toHaveBeenCalledTimes(5);

    scheduler.stop();
  });

  it('falls back to default when OHWOW_AUTOMATION_CONCURRENCY is invalid (NaN / <=0)', async () => {
    process.env.OHWOW_AUTOMATION_CONCURRENCY = 'not-a-number';
    const a = setup(makePastDueTriggers(10));
    await a.scheduler.start();
    expect(a.executeById).toHaveBeenCalledTimes(3);
    a.scheduler.stop();

    process.env.OHWOW_AUTOMATION_CONCURRENCY = '0';
    const b = setup(makePastDueTriggers(10));
    await b.scheduler.start();
    expect(b.executeById).toHaveBeenCalledTimes(3);
    b.scheduler.stop();
  });
});
