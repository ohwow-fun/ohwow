/**
 * Instance Lock
 * PID-based daemon lock to prevent multiple daemon instances.
 * Uses a PID file in the data directory with stale PID detection.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface LockInfo {
  pid: number;
  startedAt: string;
  port: number;
  version?: string;
}

/**
 * Try to acquire a daemon lock. Returns true if acquired, false if another daemon is running.
 * Automatically cleans up stale locks from crashed processes.
 */
export function acquireLock(pidPath: string, port: number, version?: string): boolean {
  const existing = readLock(pidPath);
  if (existing) {
    if (isProcessAlive(existing.pid)) {
      return false; // Another daemon is running
    }
    // Stale lock from a crashed process — clean up
    releaseLock(pidPath);
  }

  const dir = dirname(pidPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const info: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    port,
    version,
  };
  writeFileSync(pidPath, JSON.stringify(info), { mode: 0o600 });
  return true;
}

/**
 * Release the daemon lock. Only removes if we own it.
 */
export function releaseLock(pidPath: string): void {
  try {
    const existing = readLock(pidPath);
    if (existing && existing.pid !== process.pid) return; // Not ours
    if (existsSync(pidPath)) unlinkSync(pidPath);
  } catch {
    // Best effort
  }
}

/**
 * Read lock info without acquiring.
 */
export function readLock(pidPath: string): LockInfo | null {
  try {
    if (!existsSync(pidPath)) return null;
    const raw = readFileSync(pidPath, 'utf-8');
    return JSON.parse(raw) as LockInfo;
  } catch {
    return null;
  }
}

/**
 * Check if a process is alive via kill(pid, 0).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
