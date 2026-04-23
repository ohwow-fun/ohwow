import { describe, it, expect, beforeEach } from 'vitest';
import { PrioritySemaphore, PriorityQueue } from '../priority-semaphore.js';

describe('PrioritySemaphore', () => {
  let sem: PrioritySemaphore;

  beforeEach(() => {
    sem = new PrioritySemaphore(2);
  });

  describe('acquire() immediately resolves when below max concurrency', () => {
    it('acquires immediately when slots available', async () => {
      expect(sem.active).toBe(0);
      expect(sem.waiting).toBe(0);

      await sem.acquire('standard');
      expect(sem.active).toBe(1);
      expect(sem.waiting).toBe(0);

      await sem.acquire('critical');
      expect(sem.active).toBe(2);
      expect(sem.waiting).toBe(0);
    });
  });

  describe('acquire() queues when at max concurrency', () => {
    it('queues additional acquisitions when at capacity', async () => {
      const sem2 = new PrioritySemaphore(1);

      // Fill the semaphore
      await sem2.acquire('standard');
      expect(sem2.active).toBe(1);

      // Queue an acquisition
      let resolved = false;
      const pending = sem2.acquire('standard').then(() => {
        resolved = true;
      });

      // Give microtasks a chance to flush
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(sem2.waiting).toBe(1);
      expect(sem2.active).toBe(1);

      // Release should resolve the queued acquisition
      sem2.release();
      await pending;
      expect(resolved).toBe(true);
      expect(sem2.active).toBe(1);
      expect(sem2.waiting).toBe(0);

      sem2.release();
    });
  });

  describe('Higher-priority entries are resolved before lower-priority ones', () => {
    it('resolves critical before standard, and standard before bulk', async () => {
      const sem2 = new PrioritySemaphore(1);
      await sem2.acquire('standard');

      const order: PriorityQueue[] = [];

      // Queue three acquires with different priorities
      const criticalPromise = sem2.acquire('critical').then(() => {
        order.push('critical');
      });

      const bulkPromise = sem2.acquire('bulk').then(() => {
        order.push('bulk');
      });

      const standardPromise = sem2.acquire('standard').then(() => {
        order.push('standard');
      });

      // Give promises time to register in queue
      await Promise.resolve();

      expect(sem2.waiting).toBe(3);

      // Release should dequeue critical first
      sem2.release();
      await criticalPromise;
      expect(order).toEqual(['critical']);
      expect(sem2.active).toBe(1);

      // Release should dequeue standard next (before bulk)
      sem2.release();
      await standardPromise;
      expect(order).toEqual(['critical', 'standard']);
      expect(sem2.active).toBe(1);

      // Release should dequeue bulk
      sem2.release();
      await bulkPromise;
      expect(order).toEqual(['critical', 'standard', 'bulk']);
      expect(sem2.active).toBe(1);

      sem2.release();
    });
  });

  describe('release() decrements active count', () => {
    it('decrements active count on release', async () => {
      await sem.acquire('standard');
      expect(sem.active).toBe(1);

      await sem.acquire('standard');
      expect(sem.active).toBe(2);

      sem.release();
      expect(sem.active).toBe(1);

      sem.release();
      expect(sem.active).toBe(0);
    });

    it('does not dequeue when there are no waiters', async () => {
      await sem.acquire('standard');
      sem.release();
      expect(sem.active).toBe(0);
    });
  });

  describe('rejectAll() rejects every waiting entry and returns the count', () => {
    it('rejects all queued entries and returns count', async () => {
      const sem2 = new PrioritySemaphore(1);
      await sem2.acquire('standard');

      const promises = [
        sem2.acquire('critical'),
        sem2.acquire('standard'),
        sem2.acquire('bulk'),
      ];

      await Promise.resolve();
      expect(sem2.waiting).toBe(3);

      const testError = new Error('Test rejection');
      const rejectedCount = sem2.rejectAll(testError);

      expect(rejectedCount).toBe(3);
      expect(sem2.waiting).toBe(0);

      // Verify all promises rejected
      await expect(promises[0]).rejects.toThrow('Test rejection');
      await expect(promises[1]).rejects.toThrow('Test rejection');
      await expect(promises[2]).rejects.toThrow('Test rejection');

      sem2.release();
    });

    it('returns 0 when no entries are waiting', () => {
      const sem2 = new PrioritySemaphore(2);
      const testError = new Error('Test error');
      const rejectedCount = sem2.rejectAll(testError);

      expect(rejectedCount).toBe(0);
    });
  });

  describe('Timeout: acquire() with timeoutMs rejects if slot not granted in time', () => {
    it('rejects after timeout is reached', async () => {
      const sem2 = new PrioritySemaphore(1);
      await sem2.acquire('standard');

      const startTime = Date.now();
      const timeoutMs = 10;

      // This should timeout since semaphore is at capacity
      const pendingAcquire = sem2.acquire('standard', timeoutMs);

      await expect(pendingAcquire).rejects.toThrow(/timed out/);

      const elapsedMs = Date.now() - startTime;
      // Allow some buffer for test timing variations, but should be at least ~10ms
      expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 5);

      sem2.release();
    });

    it('clears timeout when acquire resolves before timeout', async () => {
      const sem2 = new PrioritySemaphore(1);
      await sem2.acquire('standard');

      // Queue an acquisition with a long timeout
      const longTimeoutMs = 5000;
      const pendingAcquire = sem2.acquire('standard', longTimeoutMs);

      // Release immediately, should resolve before timeout
      sem2.release();
      await expect(pendingAcquire).resolves.toBeUndefined();

      expect(sem2.active).toBe(1);
      sem2.release();
    });

    it('includes timeout duration in error message', async () => {
      const sem2 = new PrioritySemaphore(1);
      await sem2.acquire('standard');

      const timeoutMs = 100;
      const pendingAcquire = sem2.acquire('standard', timeoutMs);

      // The error message should mention the timeout
      await expect(pendingAcquire).rejects.toThrow(/timed out after/);

      sem2.release();
    });
  });

  describe('getQueueDepths() reflects the waiting counts per priority tier', () => {
    it('returns zero depths when no waiters', () => {
      const depths = sem.getQueueDepths();

      expect(depths).toEqual({
        critical: 0,
        standard: 0,
        bulk: 0,
      });
    });

    it('reflects queue depths for different priority tiers', async () => {
      const sem2 = new PrioritySemaphore(1);
      await sem2.acquire('standard');

      // Queue various priorities
      const p1 = sem2.acquire('critical');
      const p2 = sem2.acquire('critical');
      const p3 = sem2.acquire('standard');
      const p4 = sem2.acquire('bulk');

      await Promise.resolve();

      const depths = sem2.getQueueDepths();
      expect(depths).toEqual({
        critical: 2,
        standard: 1,
        bulk: 1,
      });

      // Dequeue critical
      sem2.release();
      await p1;

      const depths2 = sem2.getQueueDepths();
      expect(depths2).toEqual({
        critical: 1,
        standard: 1,
        bulk: 1,
      });

      // Clean up
      sem2.release();
      await p2;
      sem2.release();
      await p3;
      sem2.release();
      await p4;
      sem2.release();
    });

    it('tracks queue depths as acquisitions complete', async () => {
      const sem2 = new PrioritySemaphore(1);
      await sem2.acquire('standard');

      const promises = [
        sem2.acquire('bulk'),
        sem2.acquire('standard'),
        sem2.acquire('critical'),
      ];

      await Promise.resolve();

      let depths = sem2.getQueueDepths();
      expect(depths.critical).toBe(1);
      expect(depths.standard).toBe(1);
      expect(depths.bulk).toBe(1);

      // Release critical first (highest priority)
      sem2.release();
      await promises[2];

      depths = sem2.getQueueDepths();
      expect(depths.critical).toBe(0);
      expect(depths.standard).toBe(1);
      expect(depths.bulk).toBe(1);

      sem2.release();
      await promises[1];

      depths = sem2.getQueueDepths();
      expect(depths.critical).toBe(0);
      expect(depths.standard).toBe(0);
      expect(depths.bulk).toBe(1);

      sem2.release();
      await promises[0];

      depths = sem2.getQueueDepths();
      expect(depths).toEqual({
        critical: 0,
        standard: 0,
        bulk: 0,
      });

      sem2.release();
    });
  });

  describe('basic properties', () => {
    it('exposes concurrency limit', () => {
      const sem3 = new PrioritySemaphore(5);
      expect(sem3.concurrency).toBe(5);
    });

    it('tracks active and waiting counts correctly', async () => {
      const sem2 = new PrioritySemaphore(1);

      expect(sem2.active).toBe(0);
      expect(sem2.waiting).toBe(0);

      await sem2.acquire('standard');
      expect(sem2.active).toBe(1);

      const p1 = sem2.acquire('standard');
      // Promise created but not yet queued in microtask
      expect(sem2.active).toBe(1); // No change yet

      await Promise.resolve();
      expect(sem2.waiting).toBe(1); // Now it's queued

      sem2.release();
      await p1;
      expect(sem2.active).toBe(1);
      expect(sem2.waiting).toBe(0);

      sem2.release();
    });
  });
});
