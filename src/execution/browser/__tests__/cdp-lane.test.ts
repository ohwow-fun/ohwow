import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CdpLaneAbortedError,
  CdpLaneDeadlineError,
  _inspectCdpLaneForTests,
  _resetCdpLanesForTests,
  withCdpLane,
} from '../cdp-lane.js';

const WS = 'ws-default';

function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  _resetCdpLanesForTests();
  vi.useRealTimers();
});

describe('withCdpLane', () => {
  it('grants the lock immediately when the lane is idle', async () => {
    const result = await withCdpLane(WS, async () => 'ok');
    expect(result).toBe('ok');
    expect(_inspectCdpLaneForTests(WS)).toEqual({ held: false, queueDepth: 0 });
  });

  it('serializes concurrent callers FIFO', async () => {
    const order: string[] = [];
    const firstGate = deferred();
    const secondGate = deferred();
    const thirdGate = deferred();

    const first = withCdpLane(WS, async () => {
      order.push('first:enter');
      await firstGate.promise;
      order.push('first:exit');
    }, { label: 'first' });

    await Promise.resolve();
    const second = withCdpLane(WS, async () => {
      order.push('second:enter');
      await secondGate.promise;
      order.push('second:exit');
    }, { label: 'second' });

    await Promise.resolve();
    const third = withCdpLane(WS, async () => {
      order.push('third:enter');
      await thirdGate.promise;
      order.push('third:exit');
    }, { label: 'third' });

    await Promise.resolve();
    expect(order).toEqual(['first:enter']);
    expect(_inspectCdpLaneForTests(WS).queueDepth).toBe(2);

    firstGate.resolve();
    await first;
    await Promise.resolve();
    expect(order).toEqual(['first:enter', 'first:exit', 'second:enter']);

    secondGate.resolve();
    await second;
    await Promise.resolve();
    expect(order).toEqual([
      'first:enter', 'first:exit',
      'second:enter', 'second:exit',
      'third:enter',
    ]);

    thirdGate.resolve();
    await third;
    expect(_inspectCdpLaneForTests(WS)).toEqual({ held: false, queueDepth: 0 });
  });

  it('releases the lane when the callback throws', async () => {
    await expect(
      withCdpLane(WS, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(_inspectCdpLaneForTests(WS)).toEqual({ held: false, queueDepth: 0 });

    const result = await withCdpLane(WS, async () => 'after');
    expect(result).toBe('after');
  });

  it('isolates different workspaces', async () => {
    const otherGate = deferred();
    const promiseOther = withCdpLane('ws-other', async () => {
      await otherGate.promise;
      return 'other';
    });

    const result = await withCdpLane(WS, async () => 'default');
    expect(result).toBe('default');

    otherGate.resolve();
    await expect(promiseOther).resolves.toBe('other');
  });

  it('allows re-entrant acquisition on the same workspaceId', async () => {
    const seen: number[] = [];
    const result = await withCdpLane(WS, async () => {
      seen.push(_inspectCdpLaneForTests(WS).queueDepth);
      const inner = await withCdpLane(WS, async () => {
        seen.push(_inspectCdpLaneForTests(WS).queueDepth);
        return 'inner';
      });
      return inner;
    });
    expect(result).toBe('inner');
    expect(seen).toEqual([0, 0]);
    expect(_inspectCdpLaneForTests(WS)).toEqual({ held: false, queueDepth: 0 });
  });

  it('expires a waiter that exceeds its deadline', async () => {
    vi.useFakeTimers();
    const holderGate = deferred();
    const holder = withCdpLane(WS, async () => {
      await holderGate.promise;
    });
    await Promise.resolve();

    const waiter = withCdpLane(WS, async () => 'never', {
      label: 'slowpoke',
      deadlineMs: 50,
    });
    waiter.catch(() => {});

    await vi.advanceTimersByTimeAsync(60);
    await expect(waiter).rejects.toBeInstanceOf(CdpLaneDeadlineError);
    expect(_inspectCdpLaneForTests(WS).queueDepth).toBe(0);

    holderGate.resolve();
    await holder;
    expect(_inspectCdpLaneForTests(WS)).toEqual({ held: false, queueDepth: 0 });
  });

  it('rejects when AbortSignal fires while waiting', async () => {
    const holderGate = deferred();
    const holder = withCdpLane(WS, async () => {
      await holderGate.promise;
    });
    await Promise.resolve();

    const ac = new AbortController();
    const waiter = withCdpLane(WS, async () => 'never', {
      label: 'cancel-me',
      signal: ac.signal,
    });
    waiter.catch(() => {});
    await Promise.resolve();
    expect(_inspectCdpLaneForTests(WS).queueDepth).toBe(1);

    ac.abort();
    await expect(waiter).rejects.toBeInstanceOf(CdpLaneAbortedError);
    expect(_inspectCdpLaneForTests(WS).queueDepth).toBe(0);

    holderGate.resolve();
    await holder;
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      withCdpLane(WS, async () => 'never', { signal: ac.signal }),
    ).rejects.toBeInstanceOf(CdpLaneAbortedError);
    expect(_inspectCdpLaneForTests(WS)).toEqual({ held: false, queueDepth: 0 });
  });
});
