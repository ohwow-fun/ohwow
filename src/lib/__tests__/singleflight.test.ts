import { describe, it, expect, vi } from 'vitest';
import { singleflight } from '../singleflight.js';

describe('singleflight', () => {
  it('runs the initializer exactly once when called concurrently while not ready', async () => {
    let resource: number | null = null;
    const init = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 10));
      resource = 42;
    });
    const ensure = singleflight(() => resource !== null, init);

    // 50 concurrent callers
    await Promise.all(Array.from({ length: 50 }, () => ensure()));

    expect(init).toHaveBeenCalledOnce();
    expect(resource).toBe(42);
  });

  it('returns immediately on the fast path when isReady is true', async () => {
    let resource: number | null = 1;
    const init = vi.fn(async () => { resource = 2; });
    const ensure = singleflight(() => resource !== null, init);

    await ensure();
    await ensure();
    await ensure();

    expect(init).not.toHaveBeenCalled();
    expect(resource).toBe(1);
  });

  it('drops the in-flight promise on failure so the next call can retry', async () => {
    let attempt = 0;
    let resource: string | null = null;
    const init = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('first attempt fails');
      resource = 'ok';
    });
    const ensure = singleflight(() => resource !== null, init);

    await expect(ensure()).rejects.toThrow('first attempt fails');
    expect(init).toHaveBeenCalledTimes(1);
    expect(resource).toBeNull();

    // Retry should run init again because the cached promise was dropped.
    await ensure();
    expect(init).toHaveBeenCalledTimes(2);
    expect(resource).toBe('ok');
  });

  it('makes all concurrent callers see the same failure when init rejects', async () => {
    const init = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 5));
      throw new Error('shared failure');
    });
    const ensure = singleflight(() => false, init);

    const results = await Promise.allSettled([ensure(), ensure(), ensure(), ensure()]);

    expect(init).toHaveBeenCalledOnce();
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        expect(r.reason.message).toBe('shared failure');
      }
    }
  });

  it('handles a sequence of init → fail → retry → succeed cleanly', async () => {
    let state: 'empty' | 'ready' = 'empty';
    let attempt = 0;
    const ensure = singleflight(
      () => state === 'ready',
      async () => {
        attempt += 1;
        if (attempt < 3) throw new Error(`fail ${attempt}`);
        state = 'ready';
      },
    );

    await expect(ensure()).rejects.toThrow('fail 1');
    await expect(ensure()).rejects.toThrow('fail 2');
    await ensure();
    expect(state).toBe('ready');

    // After success, subsequent calls take the fast path.
    await ensure();
    expect(attempt).toBe(3);
  });
});
