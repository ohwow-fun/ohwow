/**
 * Priority Semaphore — MLFQ-Aware Concurrency Control
 * Extends the basic semaphore with priority queues so critical tasks
 * get dequeued before standard/bulk tasks.
 */

import { logger } from '../lib/logger.js';

export type PriorityQueue = 'critical' | 'standard' | 'bulk';

const PRIORITY_ORDER: PriorityQueue[] = ['critical', 'standard', 'bulk'];

interface PriorityQueueEntry {
  priority: PriorityQueue;
  resolve: () => void;
  reject: (error: Error) => void;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export class PrioritySemaphore {
  private current = 0;
  private queues: Map<PriorityQueue, PriorityQueueEntry[]>;

  constructor(private readonly max: number) {
    this.queues = new Map([
      ['critical', []],
      ['standard', []],
      ['bulk', []],
    ]);
  }

  get active(): number {
    return this.current;
  }

  get waiting(): number {
    let total = 0;
    for (const q of this.queues.values()) total += q.length;
    return total;
  }

  get concurrency(): number {
    return this.max;
  }

  /**
   * Acquire a slot. Higher priority entries are dequeued first.
   */
  acquire(priority: PriorityQueue = 'standard', timeoutMs?: number): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const entry: PriorityQueueEntry = {
        priority,
        resolve: () => {
          if (entry.settled) return;
          entry.settled = true;
          if (entry.timer) clearTimeout(entry.timer);
          this.current++;
          resolve();
        },
        reject: (error: Error) => {
          if (entry.settled) return;
          entry.settled = true;
          if (entry.timer) clearTimeout(entry.timer);
          const queue = this.queues.get(priority);
          if (queue) {
            const idx = queue.indexOf(entry);
            if (idx !== -1) queue.splice(idx, 1);
          }
          reject(error);
        },
        settled: false,
        timer: null,
      };

      if (timeoutMs !== undefined && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          entry.reject(new Error(`PrioritySemaphore acquire timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }

      const queue = this.queues.get(priority);
      if (queue) {
        queue.push(entry);
      } else {
        this.queues.get('standard')!.push(entry);
      }
    });
  }

  /**
   * Release a slot. Dequeues the highest-priority waiting entry.
   */
  release(): void {
    if (this.current <= 0) {
      logger.warn('[PrioritySemaphore] release() called with no active acquisitions, ignoring');
      return;
    }
    this.current--;

    // Find the highest-priority non-empty queue
    for (const priority of PRIORITY_ORDER) {
      const queue = this.queues.get(priority);
      if (queue && queue.length > 0) {
        const entry = queue.shift()!;
        entry.resolve();
        return;
      }
    }
  }

  /**
   * Reject all waiting entries in all queues.
   */
  rejectAll(error: Error): number {
    let count = 0;
    for (const queue of this.queues.values()) {
      const entries = queue.splice(0);
      for (const entry of entries) {
        entry.reject(error);
        count++;
      }
    }
    return count;
  }

  /**
   * Get queue depths for monitoring.
   */
  getQueueDepths(): Record<PriorityQueue, number> {
    return {
      critical: this.queues.get('critical')?.length ?? 0,
      standard: this.queues.get('standard')?.length ?? 0,
      bulk: this.queues.get('bulk')?.length ?? 0,
    };
  }
}
