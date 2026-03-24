/**
 * Counting semaphore for task execution concurrency control.
 * Limits how many tasks can execute simultaneously, preventing
 * Ollama request pile-up (single inference at a time) and
 * agent status race conditions.
 */

import { logger } from '../lib/logger.js';

interface QueueEntry {
  resolve: () => void;
  reject: (error: Error) => void;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export class Semaphore {
  private current = 0;
  private queue: QueueEntry[] = [];

  constructor(private readonly max: number) {}

  get active(): number {
    return this.current;
  }

  get waiting(): number {
    return this.queue.length;
  }

  get concurrency(): number {
    return this.max;
  }

  acquire(timeoutMs?: number): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = {
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
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) this.queue.splice(idx, 1);
          reject(error);
        },
        settled: false,
        timer: null,
      };

      if (timeoutMs !== undefined && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          entry.reject(new Error(`Semaphore acquire timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }

      this.queue.push(entry);
    });
  }

  release(): void {
    if (this.current <= 0) {
      logger.warn('[Semaphore] release() called with no active acquisitions, ignoring');
      return;
    }
    this.current--;
    if (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      entry.resolve();
    }
  }

  /** Reject all waiting entries in the queue. Returns the number of rejected entries. */
  rejectAll(error: Error): number {
    const count = this.queue.length;
    const entries = this.queue.splice(0);
    for (const entry of entries) {
      entry.reject(error);
    }
    return count;
  }
}
