import { describe, it, expect } from 'vitest';
import { withProfileLock, queueDepth } from '../profile-mutex.js';

/**
 * Deterministic deferred: gives the test a promise + the handles to
 * resolve/reject it later, so we can orchestrate the exact ordering of
 * critical sections without relying on setTimeout jitter.
 */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('withProfileLock', () => {
  it('serializes same-profile calls in arrival order', async () => {
    const order: string[] = [];
    const gate1 = deferred();
    const gate2 = deferred();

    const p1 = withProfileLock('Profile 1', async () => {
      order.push('1-start');
      await gate1.promise;
      order.push('1-end');
    });
    const p2 = withProfileLock('Profile 1', async () => {
      order.push('2-start');
      await gate2.promise;
      order.push('2-end');
    });

    // Let p1 enter its critical section.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['1-start']);
    // p2 hasn't started — it's queued behind p1.
    gate1.resolve();
    await p1;
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['1-start', '1-end', '2-start']);
    gate2.resolve();
    await p2;
    expect(order).toEqual(['1-start', '1-end', '2-start', '2-end']);
  });

  it('runs calls for different profiles concurrently', async () => {
    const order: string[] = [];
    const gateA = deferred();
    const gateB = deferred();

    const pA = withProfileLock('A', async () => {
      order.push('A-start');
      await gateA.promise;
      order.push('A-end');
    });
    const pB = withProfileLock('B', async () => {
      order.push('B-start');
      await gateB.promise;
      order.push('B-end');
    });

    // Both should enter their critical section without waiting for the
    // other — different profileDirs don't queue.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(expect.arrayContaining(['A-start', 'B-start']));
    expect(order).toHaveLength(2);

    gateA.resolve();
    gateB.resolve();
    await Promise.all([pA, pB]);
    expect(order).toContain('A-end');
    expect(order).toContain('B-end');
  });

  it('releases the lock for the next waiter when the held fn rejects', async () => {
    const order: string[] = [];
    const err = new Error('boom');

    const p1 = withProfileLock('Profile 1', async () => {
      order.push('1-start');
      throw err;
    }).catch((e) => { order.push(`1-rejected:${(e as Error).message}`); });

    const p2 = withProfileLock('Profile 1', async () => {
      order.push('2-start');
    });

    await Promise.all([p1, p2]);
    // p1 already produced its start + rejection log via the catch above;
    // p2 runs after because the failing fn still released the lock.
    expect(order).toEqual(['1-start', '1-rejected:boom', '2-start']);
  });

  it('timeout rejects the waiter but later waiters still acquire once the held fn settles', async () => {
    const order: string[] = [];
    const gate = deferred();

    // p1 holds the lock forever (until we resolve `gate`), past the
    // timeout window. The .then chain records how p1 settled.
    const p1Done = withProfileLock(
      'Profile 1',
      async () => {
        order.push('1-start');
        await gate.promise;
        order.push('1-end');
      },
      { timeoutMs: 25 },
    ).then(
      () => order.push('1-resolved'),
      (e: Error) => order.push(`1-rejected:${e.message.includes('timed out') ? 'TIMEOUT' : 'OTHER'}`),
    );

    // p2 queues behind p1 with a generous timeout; it should NOT deadlock
    // even though p1 timed out — once we release gate and p1's fn
    // actually finishes, p2 runs.
    const p2 = withProfileLock('Profile 1', async () => {
      order.push('2-start');
    });

    // Wait for p1's timeout to fire.
    await new Promise((r) => setTimeout(r, 75));
    expect(order).toContain('1-start');
    expect(order).toContain('1-rejected:TIMEOUT');
    // p2 must not have started yet — the lock is still held by p1's fn.
    expect(order).not.toContain('2-start');

    // Now let p1's fn actually complete. The lock releases, p2 runs.
    gate.resolve();
    await p2;
    await p1Done;
    expect(order).toContain('1-end');
    expect(order).toContain('2-start');
  });

  it('queueDepth reports the number of waiters', async () => {
    expect(queueDepth('depth-profile')).toBe(0);
    const gate1 = deferred();
    const gate2 = deferred();

    const p1 = withProfileLock('depth-profile', async () => { await gate1.promise; });
    const p2 = withProfileLock('depth-profile', async () => { await gate2.promise; });
    // Yield so the runtime registers both waiters in the chain.
    await new Promise((r) => setTimeout(r, 0));

    expect(queueDepth('depth-profile')).toBe(2);

    gate1.resolve();
    await p1;
    await new Promise((r) => setTimeout(r, 0));
    expect(queueDepth('depth-profile')).toBe(1);

    gate2.resolve();
    await p2;
    await new Promise((r) => setTimeout(r, 0));
    expect(queueDepth('depth-profile')).toBe(0);
  });
});
