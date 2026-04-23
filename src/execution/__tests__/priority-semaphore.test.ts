import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrioritySemaphore } from '../priority-semaphore.js';

describe('PrioritySemaphore', () => {
  describe('acquire() - immediate resolution', () => {
    it('immediately resolves when below max concurrency', async () => {
      const sem = new PrioritySemaphore(3);
      
      await sem.acquire('standard');
      expect(sem.active).toBe(1);
      expect(sem.waiting).toBe(0);
      
      await sem.acquire('critical');
      expect(sem.active).toBe(2);
      expect(sem.waiting).toBe(0);
      
      await sem.acquire('bulk');
      expect(sem.active).toBe(3);
      expect(sem.waiting).toBe(0);
    });
  });

  describe('acquire() - queueing', () => {
    it('queues requests when at max concurrency', async () => {
      const sem = new PrioritySemaphore(1);
      await sem.acquire('standard');
      
      let resolved = false;
      const pending = sem.acquire('standard').then(() => { resolved = true; });
      
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
  });

  describe('priority ordering', () => {
    it('resolves higher-priority entries before lower-priority ones', async () => {
      const sem = new PrioritySemaphore(1);
      await sem.acquire('standard'); // Fill the slot
      
      // Queue up requests in order: standard, critical, bulk, critical
      const order: string[] = [];
      const p1 = sem.acquire('standard').then(() => { order.push('standard'); });
      const p2 = sem.acquire('critical').then(() => { order.push('critical-1'); });
      const p3 = sem.acquire('bulk').then(() => { order.push('bulk'); });
      const p4 = sem.acquire('critical').then(() => { order.push('critical-2'); });
      
      await Promise.resolve(); // Let all queues settle
      expect(sem.waiting).toBe(4);
      
      // Release and check that critical-1 is resolved first (highest priority)
      sem.release();
      await Promise.resolve();
      expect(order).toEqual(['critical-1']);
      expect(sem.active).toBe(1);
      expect(sem.waiting).toBe(3);
      
      // Next should be critical-2 (still highest priority among remaining)
      sem.release();
      await Promise.resolve();
      expect(order).toEqual(['critical-1', 'critical-2']);
      expect(sem.waiting).toBe(2);
      
      // Next should be standard (standard priority before bulk)
      sem.release();
      await Promise.resolve();
      expect(order).toEqual(['critical-1', 'critical-2', 'standard']);
      expect(sem.waiting).toBe(1);
      
      // Finally bulk
      sem.release();
      await p3;
      expect(order).toEqual(['critical-1', 'critical-2', 'standard', 'bulk']);
      
      // Clean up
      sem.release();
    });

    it('dequeues critical before standard, standard before bulk', async () => {
      const sem = new PrioritySemaphore(1);
      await sem.acquire('standard'); // Occupies the slot
      
      // Queue in mixed order
      const p1 = sem.acquire('bulk');
      const p2 = sem.acquire('critical');
      const p3 = sem.acquire('standard');
      
      await Promise.resolve();
      expect(sem.waiting).toBe(3);
      
      // All releases should follow priority order: critical, standard, bulk
      const resolved: string[] = [];
      
      p2.then(() => resolved.push('critical'));
      p3.then(() => resolved.push('standard'));
      p1.then(() => resolved.push('bulk'));
      
      sem.release(); // Should release critical
      await Promise.resolve();
      expect(resolved).toEqual(['critical']);
      
      sem.release(); // Should release standard
      await Promise.resolve();
      expect(resolved).toEqual(['critical', 'standard']);
      
      sem.release(); // Should release bulk
      await p1;
      expect(resolved).toEqual(['critical', 'standard', 'bulk']);
      
      sem.release();
    });
  });

  describe('release()', () => {
    it('decrements active count', async () => {
      const sem = new PrioritySemaphore(3);
      
      await sem.acquire();
      expect(sem.active).toBe(1);
      
      await sem.acquire();
      expect(sem.active).toBe(2);
      
      sem.release();
      expect(sem.active).toBe(1);
      
      sem.release();
      expect(sem.active).toBe(0);
    });

    it('processes the highest priority queue first', async () => {
      const sem = new PrioritySemaphore(1);
      await sem.acquire();
      
      const resolved: string[] = [];
      sem.acquire('bulk').then(() => resolved.push('bulk'));
      sem.acquire('standard').then(() => resolved.push('standard'));
      sem.acquire('critical').then(() => resolved.push('critical'));
      
      await Promise.resolve();
      
      sem.release();
      await Promise.resolve();
      expect(resolved[0]).toBe('critical');
      
      sem.release();
      sem.release();
      sem.release();
    });
  });

  describe('rejectAll()', () => {
    it('rejects every waiting entry and returns the count', async () => {
      const sem = new PrioritySemaphore(1);
      await sem.acquire('standard');
      
      const error = new Error('Test error');
      
      // Queue up multiple requests
      const p1 = sem.acquire('critical');
      const p2 = sem.acquire('standard');
      const p3 = sem.acquire('bulk');
      
      await Promise.resolve();
      expect(sem.waiting).toBe(3);
      
      // Reject all
      const rejectedCount = sem.rejectAll(error);
      
      expect(rejectedCount).toBe(3);
      expect(sem.waiting).toBe(0);
      
      await expect(p1).rejects.toThrow('Test error');
      await expect(p2).rejects.toThrow('Test error');
      await expect(p3).rejects.toThrow('Test error');
      
      sem.release();
    });

    it('returns 0 when no entries are waiting', () => {
      const sem = new PrioritySemaphore(5);
      const error = new Error('Test error');
      
      const count = sem.rejectAll(error);
      expect(count).toBe(0);
    });

    it('rejects entries from all priority levels', async () => {
      const sem = new PrioritySemaphore(1);
      await sem.acquire();
      
      const error = new Error('Shutdown');
      const rejections: boolean[] = [false, false, false, false];
      
      // Queue requests at different priorities
      const critical1 = sem.acquire('critical').catch((e) => { rejections[0] = e.message === 'Shutdown'; });
      const standard1 = sem.acquire('standard').catch((e) => { rejections[1] = e.message === 'Shutdown'; });
      const critical2 = sem.acquire('critical').catch((e) => { rejections[2] = e.message === 'Shutdown'; });
      const bulk1 = sem.acquire('bulk').catch((e) => { rejections[3] = e.message === 'Shutdown'; });
      
      await Promise.resolve();
      expect(sem.waiting).toBe(4);
      
      const count = sem.rejectAll(error);
      
      expect(count).toBe(4);
      
      await Promise.all([critical1, standard1, critical2, bulk1]);
      expect(rejections).toEqual([true, true, true, true]);
      
      sem.release();
    });
  });

  describe('acquire() with timeout', () => {
    it('rejects if slot not granted within timeout', async () => {
      const sem = new PrioritySemaphore(1);
      await sem.acquire();
      
      // Use a small timeout (10ms) without fake timers, just real waiting
      const startTime = Date.now();
      const pending = sem.acquire('standard', 10);
      
      await expect(pending).rejects.toThrow(/PrioritySemaphore acquire timed out/);
      
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(10);
      expect(sem.waiting).toBe(0);
      expect(sem.active).toBe(1);
      
      sem.release();
    });

    it('resolves before timeout if slot becomes available', async () => {
      const sem = new PrioritySemaphore(1);
      await sem.acquire();
      
      const pending = sem.acquire('standard', 100);
      
      // Release before timeout fires
      setTimeout(() => {
        sem.release();
      }, 20);
      
      await pending;
      expect(sem.active).toBe(1);
      expect(sem.waiting).toBe(0);
      
      sem.release();
    });

    it('timeout works with different priority levels', async () => {
      const sem = new PrioritySemaphore(1);
      await sem.acquire();
      
      const startTime = Date.now();
      const pending = sem.acquire('critical', 15);
      
      await expect(pending).rejects.toThrow(/PrioritySemaphore acquire timed out/);
      
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(15);
      
      sem.release();
    });
  });

  describe('getQueueDepths()', () => {
    it('reflects the waiting counts per priority tier', async () => {
      const sem = new PrioritySemaphore(1);
      await sem.acquire('standard');
      
      // All queues start empty
      expect(sem.getQueueDepths()).toEqual({
        critical: 0,
        standard: 0,
        bulk: 0,
      });
      
      // Queue up requests
      sem.acquire('critical');
      sem.acquire('critical');
      sem.acquire('standard');
      sem.acquire('bulk');
      sem.acquire('bulk');
      sem.acquire('bulk');
      
      await Promise.resolve();
      
      const depths = sem.getQueueDepths();
      expect(depths.critical).toBe(2);
      expect(depths.standard).toBe(1);
      expect(depths.bulk).toBe(3);
    });

    it('updates after release', async () => {
      const sem = new PrioritySemaphore(1);
      await sem.acquire();
      
      const p1 = sem.acquire('critical');
      const p2 = sem.acquire('standard');
      
      await Promise.resolve();
      expect(sem.getQueueDepths()).toEqual({
        critical: 1,
        standard: 1,
        bulk: 0,
      });
      
      sem.release(); // critical is dequeued
      await p1;
      
      expect(sem.getQueueDepths()).toEqual({
        critical: 0,
        standard: 1,
        bulk: 0,
      });
      
      sem.release();
      sem.release();
    });

    it('returns zero depths after rejectAll', async () => {
      const sem = new PrioritySemaphore(1);
      await sem.acquire();
      
      sem.acquire('critical').catch(() => {});
      sem.acquire('standard').catch(() => {});
      sem.acquire('bulk').catch(() => {});
      
      await Promise.resolve();
      expect(sem.waiting).toBe(3);
      
      sem.rejectAll(new Error('Test'));
      
      const depths = sem.getQueueDepths();
      expect(depths).toEqual({
        critical: 0,
        standard: 0,
        bulk: 0,
      });
      
      sem.release();
    });
  });

  describe('concurrency getter', () => {
    it('returns the max concurrency passed to constructor', () => {
      const sem = new PrioritySemaphore(5);
      expect(sem.concurrency).toBe(5);
    });
  });

  describe('default priority', () => {
    it('uses standard as default priority when not specified', async () => {
      const sem = new PrioritySemaphore(1);
      await sem.acquire();
      
      const p1 = sem.acquire('critical');
      const p2 = sem.acquire(); // Should default to 'standard'
      
      await Promise.resolve();
      
      const resolved: string[] = [];
      p1.then(() => resolved.push('critical'));
      p2.then(() => resolved.push('standard'));
      
      sem.release(); // Should dequeue critical first
      await Promise.resolve();
      expect(resolved[0]).toBe('critical');
      
      sem.release();
      sem.release();
    });
  });
});
