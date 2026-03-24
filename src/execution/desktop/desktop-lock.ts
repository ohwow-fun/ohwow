/**
 * Desktop Session Lock
 * In-memory mutex ensuring only one agent task can control the desktop at a time.
 * This is per-process (single runtime), not distributed.
 */

import { logger } from '../../lib/logger.js';

export interface DesktopLockHolder {
  agentId: string;
  taskId: string;
  acquiredAt: number;
}

/**
 * Singleton desktop lock. Only one task at a time can hold desktop control.
 */
class DesktopLock {
  private holder: DesktopLockHolder | null = null;

  /**
   * Attempt to acquire the desktop lock for a given agent/task.
   * Returns true if acquired, false if already held by another task.
   */
  acquire(agentId: string, taskId: string): boolean {
    // Already held by this task — idempotent
    if (this.holder?.taskId === taskId) return true;

    // Held by another task — reject
    if (this.holder) {
      logger.warn(
        { currentHolder: this.holder, rejectedTask: taskId },
        '[desktop-lock] Desktop lock already held',
      );
      return false;
    }

    this.holder = { agentId, taskId, acquiredAt: Date.now() };
    logger.info({ agentId, taskId }, '[desktop-lock] Desktop lock acquired');
    return true;
  }

  /**
   * Release the lock for a specific task.
   * No-op if the task doesn't hold the lock (safety: don't release another task's lock).
   */
  release(taskId: string): void {
    if (this.holder?.taskId !== taskId) return;
    logger.info({ taskId }, '[desktop-lock] Desktop lock released');
    this.holder = null;
  }

  /** Check if a specific task holds the lock. */
  isHeldBy(taskId: string): boolean {
    return this.holder?.taskId === taskId;
  }

  /** Get current lock holder info, or null. */
  getHolder(): DesktopLockHolder | null {
    return this.holder;
  }

  /** Force-release the lock (for emergency stop). */
  forceRelease(): void {
    if (this.holder) {
      logger.warn({ holder: this.holder }, '[desktop-lock] Force-releasing desktop lock');
      this.holder = null;
    }
  }
}

/** Singleton instance — shared across the runtime process */
export const desktopLock = new DesktopLock();
