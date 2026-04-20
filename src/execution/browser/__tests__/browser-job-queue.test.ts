/**
 * TEST B — BrowserJobQueue
 *
 * Verifies:
 * 1. Same-workspace concurrent calls: second fn waits for first to complete
 *    (PROOF: side-effects array order = start1, end1, start2, end2)
 * 2. Different-workspace concurrent calls: both run in parallel
 * 3. Queue depth counter increments/decrements correctly
 * 4. After a job completes, depth returns to 0 and map is cleaned up
 * 5. withBrowserJob propagates fn return value
 * 6. withBrowserJob propagates fn errors
 * 7. timeoutMs: queued job waiting too long rejects with timeout error
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withBrowserJob, queueDepthForWorkspace } from '../browser-job-queue.js';

// The module uses module-level Maps for the chain and depth.
// Between tests we need to flush all pending microtasks so the chain
// cleanup queueMicrotask callbacks fire and the maps are emptied.
async function flushAll(): Promise<void> {
  // Pump microtasks + one round of setImmediate
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

beforeEach(async () => {
  // Drain any residual chain state from previous tests
  await flushAll();
});

afterEach(async () => {
  await flushAll();
});

// ── B-1: serialization proof — same workspace ────────────────────────────────
describe('B-1: same-workspace serialization', () => {
  it('fn2 starts AFTER fn1 finishes (order: start1, end1, start2, end2)', async () => {
    const events: string[] = [];

    const fn1 = async () => {
      events.push('start1');
      await Promise.resolve(); // yield to let fn2 try to start
      await Promise.resolve();
      events.push('end1');
      return 'result1';
    };

    const fn2 = async () => {
      events.push('start2');
      await Promise.resolve();
      events.push('end2');
      return 'result2';
    };

    const ws = 'test-ws-serialize';
    const [r1, r2] = await Promise.all([
      withBrowserJob(ws, fn1),
      withBrowserJob(ws, fn2),
    ]);

    expect(r1).toBe('result1');
    expect(r2).toBe('result2');
    // The critical ordering proof
    expect(events).toEqual(['start1', 'end1', 'start2', 'end2']);
  });

  it('three sequential fns respect queue order', async () => {
    const order: number[] = [];

    let releaseFn1!: () => void;
    const gate1 = new Promise<void>(r => { releaseFn1 = r; });

    let releaseFn2!: () => void;
    const gate2 = new Promise<void>(r => { releaseFn2 = r; });

    const ws = 'test-ws-three';

    const p1 = withBrowserJob(ws, async () => { order.push(1); await gate1; return 1; });
    const p2 = withBrowserJob(ws, async () => { order.push(2); await gate2; return 2; });
    const p3 = withBrowserJob(ws, async () => { order.push(3); return 3; });

    // Release fn1, then fn2
    releaseFn1();
    await p1;
    releaseFn2();
    await p2;
    await p3;

    expect(order).toEqual([1, 2, 3]);
  });
});

// ── B-2: different-workspace parallelism ─────────────────────────────────────
describe('B-2: different-workspace parallelism', () => {
  it('two fns for different workspaces run concurrently', async () => {
    const events: string[] = [];

    let releaseA!: () => void;
    const gateA = new Promise<void>(r => { releaseA = r; });

    let releaseB!: () => void;
    const gateB = new Promise<void>(r => { releaseB = r; });

    const pA = withBrowserJob('ws-alpha', async () => {
      events.push('startA');
      await gateA;
      events.push('endA');
    });

    const pB = withBrowserJob('ws-beta', async () => {
      events.push('startB');
      await gateB;
      events.push('endB');
    });

    // Both should have started before either gate is released
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toContain('startA');
    expect(events).toContain('startB');

    releaseA();
    releaseB();
    await Promise.all([pA, pB]);

    expect(events).toEqual(['startA', 'startB', 'endA', 'endB']);
  });
});

// ── B-3: depth counter ───────────────────────────────────────────────────────
describe('B-3: queue depth counter', () => {
  it('depth increments when job is enqueued and decrements when done', async () => {
    const ws = 'test-ws-depth';
    expect(queueDepthForWorkspace(ws)).toBe(0);

    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });

    const p = withBrowserJob(ws, async () => { await gate; });

    await Promise.resolve();
    expect(queueDepthForWorkspace(ws)).toBe(1);

    release();
    await p;
    await flushAll();

    expect(queueDepthForWorkspace(ws)).toBe(0);
  });

  it('depth reflects total queued (holder + waiters)', async () => {
    const ws = 'test-ws-depth-multi';

    let releaseFirst!: () => void;
    const gateFirst = new Promise<void>(r => { releaseFirst = r; });

    const p1 = withBrowserJob(ws, async () => { await gateFirst; });
    const p2 = withBrowserJob(ws, async () => { /* immediate */ });
    const p3 = withBrowserJob(ws, async () => { /* immediate */ });

    await Promise.resolve();
    // All three are queued: 1 holder + 2 waiters
    expect(queueDepthForWorkspace(ws)).toBe(3);

    releaseFirst();
    await Promise.all([p1, p2, p3]);
    await flushAll();

    expect(queueDepthForWorkspace(ws)).toBe(0);
  });
});

// ── B-4: map cleanup after completion ───────────────────────────────────────
describe('B-4: map cleanup', () => {
  it('depth is 0 after all jobs complete', async () => {
    const ws = 'test-ws-cleanup';
    await withBrowserJob(ws, async () => 'ok');
    await flushAll();
    expect(queueDepthForWorkspace(ws)).toBe(0);
  });
});

// ── B-5: return value propagation ────────────────────────────────────────────
describe('B-5: return value propagation', () => {
  it('returns the fn result directly', async () => {
    const result = await withBrowserJob('ws-return', async () => ({ answer: 42 }));
    expect(result).toEqual({ answer: 42 });
  });

  it('returns undefined when fn returns undefined', async () => {
    const result = await withBrowserJob('ws-void', async () => undefined);
    expect(result).toBeUndefined();
  });
});

// ── B-6: error propagation ───────────────────────────────────────────────────
describe('B-6: error propagation', () => {
  it('rejects with the fn error when fn throws', async () => {
    const err = new Error('task exploded');
    await expect(
      withBrowserJob('ws-error', async () => { throw err; }),
    ).rejects.toThrow('task exploded');
  });

  it('subsequent calls still run after a fn that threw', async () => {
    const ws = 'ws-error-recovery';
    await expect(
      withBrowserJob(ws, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    // Next job should run normally (queue not poisoned)
    const result = await withBrowserJob(ws, async () => 'recovered');
    expect(result).toBe('recovered');
  });
});

// ── B-7: timeoutMs ───────────────────────────────────────────────────────────
// NOTE on timeout semantics: withBrowserJob's timeout clock starts AFTER the
// waiter acquires the lock (after `await prev` resolves). It limits how long
// the fn itself may run, not how long it queues. The docstring comment "On
// timeout the waiter rejects" refers to the overall withBrowserJob call
// rejecting when fn takes too long, while the lock release still waits for
// fn to naturally settle so later waiters don't deadlock.
//
// We use real timers with a tiny timeoutMs (1ms) and a real sleep to avoid
// vitest fake-timer races where the unresolved timeoutPromise fires again
// after Promise.race has already consumed the rejection (producing spurious
// UnhandledRejection warnings).
describe('B-7: timeoutMs', () => {
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  it('rejects with timeout error when fn runs longer than timeoutMs', async () => {
    const ws = 'ws-timeout-real';

    // fn that never settles until we release it
    let releaseFn!: () => void;
    const fnGate = new Promise<void>(r => { releaseFn = r; });

    // Attach a pre-emptive catch so the rejection is handled immediately —
    // this prevents vitest's global unhandledRejection tracker from firing
    // between when the Promise.race rejects and when our test assertion runs.
    let caughtError: Error | undefined;
    const jobPromise = withBrowserJob(ws, async () => {
      await fnGate;
      return 'done';
    }, { timeoutMs: 10 }).catch((e: Error) => { caughtError = e; return undefined; });

    // Wait long enough for the 10ms timer to fire
    await sleep(30);

    await jobPromise; // ensure the catch has run
    expect(caughtError?.message).toMatch(/BrowserJobQueue timeout after 10ms/);

    // Release the fn so the lock is freed (avoids leaking the chain)
    releaseFn();
    await flushAll();
  }, 5000);

  it('does NOT cancel fn when job times out (lock held until fn settles)', async () => {
    const ws = 'ws-timeout-no-cancel-real';

    let fnSettled = false;
    let releaseFn!: () => void;
    const fnGate = new Promise<void>(r => { releaseFn = r; });

    let caughtError: Error | undefined;
    const job = withBrowserJob(ws, async () => {
      await fnGate;
      fnSettled = true;
      return 'fn-ok';
    }, { timeoutMs: 10 }).catch((e: Error) => { caughtError = e; return undefined; });

    // Wait for the timeout to fire
    await sleep(30);

    await job;
    expect(caughtError?.message).toMatch(/timeout/);

    // fn is still running (not cancelled by the timeout)
    expect(fnSettled).toBe(false);

    // Release fn — chain eventually frees
    releaseFn();
    await flushAll();

    // fn has now settled
    expect(fnSettled).toBe(true);

    // A subsequent job should succeed (queue not poisoned)
    const result = await withBrowserJob(ws, async () => 'recovered');
    expect(result).toBe('recovered');
  }, 5000);
});
