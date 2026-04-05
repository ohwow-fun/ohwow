import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Semaphore } from '../semaphore.js';
import { logger } from '../../lib/logger.js';

describe('Semaphore', () => {
  describe('concurrency getter', () => {
    it('returns the constructor value', () => {
      const sem = new Semaphore(5);
      expect(sem.concurrency).toBe(5);
    });
  });

  describe('active getter', () => {
    it('starts at 0', () => {
      const sem = new Semaphore(3);
      expect(sem.active).toBe(0);
    });

    it('tracks current acquisition count', async () => {
      const sem = new Semaphore(3);
      await sem.acquire();
      expect(sem.active).toBe(1);
      await sem.acquire();
      expect(sem.active).toBe(2);
      sem.release();
      expect(sem.active).toBe(1);
      sem.release();
      expect(sem.active).toBe(0);
    });
  });

  describe('waiting getter', () => {
    it('starts at 0', () => {
      const sem = new Semaphore(1);
      expect(sem.waiting).toBe(0);
    });

    it('tracks queue length', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();
      const p1 = sem.acquire();
      expect(sem.waiting).toBe(1);
      const p2 = sem.acquire();
      expect(sem.waiting).toBe(2);
      sem.release();
      await p1;
      expect(sem.waiting).toBe(1);
      sem.release();
      await p2;
      expect(sem.waiting).toBe(0);
      sem.release();
    });
  });

  describe('acquire()', () => {
    it('resolves immediately when under capacity', async () => {
      const sem = new Semaphore(3);
      await sem.acquire();
      await sem.acquire();
      expect(sem.active).toBe(2);
      expect(sem.waiting).toBe(0);
    });

    it('queues when at capacity', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      let resolved = false;
      const pending = sem.acquire().then(() => { resolved = true; });

      // Give microtasks a chance to flush
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(sem.waiting).toBe(1);
      expect(sem.active).toBe(1);

      sem.release();
      await pending;
      expect(resolved).toBe(true);
      expect(sem.active).toBe(1);
      expect(sem.waiting).toBe(0);
      sem.release();
    });

    it('resolves at exact capacity boundary (max=1)', async () => {
      const sem = new Semaphore(1);
      // First acquire fills capacity
      await sem.acquire();
      expect(sem.active).toBe(1);

      // Second acquire must wait
      let secondResolved = false;
      const p = sem.acquire().then(() => { secondResolved = true; });
      await Promise.resolve();
      expect(secondResolved).toBe(false);
      expect(sem.waiting).toBe(1);

      sem.release();
      await p;
      expect(secondResolved).toBe(true);
      sem.release();
    });
  });

  describe('release()', () => {
    it('dequeues next waiter in FIFO order', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      const order: number[] = [];
      const p1 = sem.acquire().then(() => { order.push(1); });
      const p2 = sem.acquire().then(() => { order.push(2); });
      const p3 = sem.acquire().then(() => { order.push(3); });

      sem.release();
      await p1;
      sem.release();
      await p2;
      sem.release();
      await p3;

      expect(order).toEqual([1, 2, 3]);
      sem.release();
    });

    it('warns and is a no-op when no active acquisitions', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation((() => {}) as never);
      const sem = new Semaphore(2);

      sem.release();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[Semaphore] release() called with no active acquisitions, ignoring'
      );
      expect(sem.active).toBe(0);

      warnSpy.mockRestore();
    });

    it('does not go negative on double release (warns twice)', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation((() => {}) as never);
      const sem = new Semaphore(1);
      await sem.acquire();
      sem.release();
      expect(sem.active).toBe(0);

      // Two extra releases
      sem.release();
      sem.release();
      expect(sem.active).toBe(0);
      expect(warnSpy).toHaveBeenCalledTimes(2);

      warnSpy.mockRestore();
    });
  });

  describe('acquire() with timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects after timeout', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      const pending = sem.acquire(5000);

      vi.advanceTimersByTime(5000);

      await expect(pending).rejects.toThrow('Semaphore acquire timed out after 5s');
      expect(sem.waiting).toBe(0);
      expect(sem.active).toBe(1);

      sem.release();
    });

    it('rounds timeout in error message', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      const pending = sem.acquire(3700);
      vi.advanceTimersByTime(3700);

      await expect(pending).rejects.toThrow('Semaphore acquire timed out after 4s');
      sem.release();
    });

    it('resolves before timeout and clears timer', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      const pending = sem.acquire(10000);

      // Release before timeout fires
      sem.release();
      await pending;

      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(sem.active).toBe(1);
      expect(sem.waiting).toBe(0);

      sem.release();
      clearTimeoutSpy.mockRestore();
    });

    it('does not set timer when timeoutMs is undefined', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      const callsBefore = setTimeoutSpy.mock.calls.length;

      const pending = sem.acquire();
      const callsAfter = setTimeoutSpy.mock.calls.length;

      // No new setTimeout calls for the acquire
      expect(callsAfter).toBe(callsBefore);

      sem.release();
      await pending;
      sem.release();
      setTimeoutSpy.mockRestore();
    });

    it('does not set timer when timeoutMs is 0', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      const callsBefore = setTimeoutSpy.mock.calls.length;

      const pending = sem.acquire(0);
      const callsAfter = setTimeoutSpy.mock.calls.length;

      expect(callsAfter).toBe(callsBefore);

      sem.release();
      await pending;
      sem.release();
      setTimeoutSpy.mockRestore();
    });
  });

  describe('rejectAll()', () => {
    it('rejects all queued entries and returns count', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      const errors: Error[] = [];
      const p1 = sem.acquire().catch((e) => { errors.push(e); });
      const p2 = sem.acquire().catch((e) => { errors.push(e); });
      const p3 = sem.acquire().catch((e) => { errors.push(e); });

      expect(sem.waiting).toBe(3);

      const count = sem.rejectAll(new Error('shutdown'));
      expect(count).toBe(3);
      expect(sem.waiting).toBe(0);

      await Promise.all([p1, p2, p3]);

      expect(errors).toHaveLength(3);
      for (const err of errors) {
        expect(err.message).toBe('shutdown');
      }

      // The original acquisition is still active
      expect(sem.active).toBe(1);
      sem.release();
    });

    it('returns 0 on empty queue', () => {
      const sem = new Semaphore(3);
      const count = sem.rejectAll(new Error('nope'));
      expect(count).toBe(0);
      expect(sem.waiting).toBe(0);
    });

    it('release after rejectAll does not dequeue phantom entries', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      const p1 = sem.acquire().catch(() => {});
      const p2 = sem.acquire().catch(() => {});

      sem.rejectAll(new Error('cleared'));
      await Promise.all([p1, p2]);

      expect(sem.waiting).toBe(0);
      expect(sem.active).toBe(1);

      // Release the original acquisition
      sem.release();
      expect(sem.active).toBe(0);
      expect(sem.waiting).toBe(0);

      // Extra release should warn, not crash
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation((() => {}) as never);
      sem.release();
      expect(sem.active).toBe(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });

  describe('multiple sequential acquire/release cycles', () => {
    it('handles repeated acquire and release correctly', async () => {
      const sem = new Semaphore(2);

      for (let i = 0; i < 10; i++) {
        await sem.acquire();
        expect(sem.active).toBe(1);
        sem.release();
        expect(sem.active).toBe(0);
      }
    });

    it('handles interleaved cycles', async () => {
      const sem = new Semaphore(2);

      await sem.acquire();
      await sem.acquire();
      expect(sem.active).toBe(2);

      sem.release();
      expect(sem.active).toBe(1);

      await sem.acquire();
      expect(sem.active).toBe(2);

      sem.release();
      sem.release();
      expect(sem.active).toBe(0);
    });
  });

  describe('stress: many concurrent acquires', () => {
    it('processes all waiters in order with max=3', async () => {
      const sem = new Semaphore(3);

      // Fill capacity
      await sem.acquire();
      await sem.acquire();
      await sem.acquire();
      expect(sem.active).toBe(3);

      // Queue 20 waiters
      const order: number[] = [];
      const promises: Promise<void>[] = [];

      for (let i = 0; i < 20; i++) {
        const idx = i;
        promises.push(
          sem.acquire().then(() => {
            order.push(idx);
          })
        );
      }

      expect(sem.waiting).toBe(20);

      // Release all: 3 initial + 20 queued
      for (let i = 0; i < 23; i++) {
        sem.release();
        // Allow microtasks to process
        await Promise.resolve();
      }

      await Promise.all(promises);

      expect(order).toEqual(Array.from({ length: 20 }, (_, i) => i));
      expect(sem.active).toBe(0);
      expect(sem.waiting).toBe(0);
    });

    it('never exceeds max concurrent acquisitions', async () => {
      const sem = new Semaphore(3);
      let maxObserved = 0;

      const tasks = Array.from({ length: 15 }, (_, _i) =>
        sem.acquire().then(async () => {
          maxObserved = Math.max(maxObserved, sem.active);
          // Simulate async work
          await Promise.resolve();
          sem.release();
        })
      );

      await Promise.all(tasks);

      expect(maxObserved).toBeLessThanOrEqual(3);
      expect(sem.active).toBe(0);
    });
  });
});
