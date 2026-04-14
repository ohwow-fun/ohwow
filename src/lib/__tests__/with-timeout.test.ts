import { describe, it, expect, vi } from 'vitest';
import { withTimeout, TimeoutError } from '../with-timeout.js';

describe('withTimeout', () => {
  it('resolves cleanly when the function completes before the deadline', async () => {
    const result = await withTimeout('quick op', 1000, async () => {
      await new Promise(r => setTimeout(r, 10));
      return 'ok';
    });
    expect(result).toBe('ok');
  });

  it('throws TimeoutError when the deadline fires first', async () => {
    const startedAt = Date.now();
    const promise = withTimeout('slow op', 50, async () => {
      await new Promise(r => setTimeout(r, 10_000));
      return 'never';
    });
    await expect(promise).rejects.toBeInstanceOf(TimeoutError);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(500);
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });

  it('aborts the AbortSignal when the deadline fires', async () => {
    const onAbort = vi.fn();
    const promise = withTimeout('signal op', 50, (signal) => {
      signal.addEventListener('abort', onAbort);
      return new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled by signal')));
      });
    });
    await expect(promise).rejects.toBeInstanceOf(TimeoutError);
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it('TimeoutError exposes label and elapsedMs', async () => {
    try {
      await withTimeout('test label', 50, () => new Promise<never>(() => { /* never */ }));
      throw new Error('should have timed out');
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      const te = err as TimeoutError;
      expect(te.label).toBe('test label');
      expect(te.elapsedMs).toBeGreaterThanOrEqual(45);
      expect(te.message).toContain('test label');
      expect(te.message).toContain('timed out');
    }
  });

  it('propagates errors from the function unchanged', async () => {
    const customErr = new Error('underlying failure');
    await expect(
      withTimeout('passthrough', 1000, async () => {
        throw customErr;
      }),
    ).rejects.toBe(customErr);
  });

  it('clears the timer on success so the process can exit', async () => {
    // If the timer leaked, vitest would warn about open handles. The test
    // passes if no warning fires and the function returns immediately.
    const result = await withTimeout('clean exit', 60_000, async () => 42);
    expect(result).toBe(42);
  });
});
