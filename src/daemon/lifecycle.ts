/**
 * Daemon Lifecycle
 * Helpers to detect, start, and stop the daemon process.
 */

import { join } from 'path';
import { spawn } from 'child_process';
import { openSync, existsSync, statSync, renameSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { readLock, isProcessAlive } from '../lib/instance-lock.js';
import { logger } from '../lib/logger.js';

/** Path to the replaced marker file */
function getReplacedPath(dataDir: string): string {
  return join(dataDir, '.replaced');
}

/**
 * Write a marker file so the TUI knows the daemon was replaced by another device
 * and should NOT auto-respawn it.
 */
export function writeReplacedMarker(dataDir: string): void {
  try {
    writeFileSync(getReplacedPath(dataDir), JSON.stringify({
      at: new Date().toISOString(),
      reason: 'Another device connected',
    }));
  } catch {
    // Best effort
  }
}

/**
 * Check if the daemon was recently replaced (within withinMs, default 5 minutes).
 * Returns true if the TUI should NOT respawn the daemon.
 */
export function wasRecentlyReplaced(dataDir: string, withinMs = 300_000): boolean {
  const markerPath = getReplacedPath(dataDir);
  try {
    if (!existsSync(markerPath)) return false;
    const raw = readFileSync(markerPath, 'utf-8');
    const marker = JSON.parse(raw) as { at: string };
    const age = Date.now() - new Date(marker.at).getTime();
    return age < withinMs;
  } catch {
    return false;
  }
}

/**
 * Clear the replaced marker (e.g., after a successful reconnect).
 */
export function clearReplacedMarker(dataDir: string): void {
  try {
    const markerPath = getReplacedPath(dataDir);
    if (existsSync(markerPath)) {
      unlinkSync(markerPath);
    }
  } catch {
    // Best effort
  }
}

/** Max log file size before rotation (10 MB) */
const MAX_LOG_SIZE = 10 * 1024 * 1024;

/** Get the daemon log file path */
export function getLogPath(dataDir: string): string {
  return join(dataDir, 'daemon.log');
}

/**
 * Rotate daemon.log if it exceeds MAX_LOG_SIZE.
 * Renames daemon.log -> daemon.log.1 (overwriting any previous .1 file).
 */
function rotateLogIfNeeded(logPath: string): void {
  try {
    if (!existsSync(logPath)) return;
    const stats = statSync(logPath);
    if (stats.size > MAX_LOG_SIZE) {
      renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // Best effort — don't block startup
  }
}

/** Default PID file location inside the data directory */
export function getPidPath(dataDir: string): string {
  return join(dataDir, 'daemon.pid');
}

/**
 * Check if a daemon is already running.
 * First checks the PID file, then verifies with a health endpoint.
 */
export async function isDaemonRunning(dataDir: string, port: number): Promise<{ running: boolean; pid?: number; healthy?: boolean }> {
  const lock = readLock(getPidPath(dataDir));
  if (!lock) return { running: false };

  if (!isProcessAlive(lock.pid)) {
    return { running: false };
  }

  // Verify via health endpoint (PID alone doesn't mean the HTTP server is up)
  const checkPort = lock.port || port;
  try {
    const res = await fetch(`http://localhost:${checkPort}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json() as { status: string };
      if (data.status === 'healthy' || data.status === 'degraded') {
        return { running: true, pid: lock.pid };
      }
    }
  } catch {
    // Health check failed but process is alive — might still be starting up.
    // Return running with a flag so callers can distinguish a healthy daemon
    // from one that's still starting or hung.
    return { running: true, pid: lock.pid, healthy: false };
  }

  return { running: false };
}

/**
 * Start the daemon as a detached background child process.
 * Returns the PID of the spawned process.
 */
export function startDaemonBackground(execPath: string, port: number, dataDir: string): number {
  const logPath = getLogPath(dataDir);
  rotateLogIfNeeded(logPath);

  // Open log file for append (creates if missing)
  const logFd = openSync(logPath, 'a');

  // When entry point is TypeScript (dev mode), use tsx loader
  const isTs = execPath.endsWith('.ts');
  const args = isTs
    ? ['--import', 'tsx', execPath, '--daemon']
    : [execPath, '--daemon'];

  // Forward OHWOW_WORKSPACE if set so the detached child binds to the same
  // workspace as the parent. (process.env spread above already covers this in
  // most cases, but we set it explicitly to be defensive against tools that
  // strip env vars when spawning subprocesses.)
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OHWOW_PORT: String(port),
  };
  if (process.env.OHWOW_WORKSPACE) {
    childEnv.OHWOW_WORKSPACE = process.env.OHWOW_WORKSPACE;
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: childEnv,
  });

  child.unref();
  return child.pid!;
}

/**
 * Wait for the daemon to become healthy (up to timeoutMs).
 */
export async function waitForDaemon(port: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const interval = 300;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

/**
 * Stop a running daemon. On Windows, uses HTTP shutdown endpoint for graceful
 * cleanup since SIGTERM maps to TerminateProcess (no cleanup). On Unix, sends SIGTERM.
 */
export async function stopDaemon(dataDir: string): Promise<boolean> {
  const lock = readLock(getPidPath(dataDir));
  if (!lock) return false;

  if (!isProcessAlive(lock.pid)) return false;

  // On Windows, use HTTP shutdown endpoint (SIGTERM just kills without cleanup)
  if (process.platform === 'win32' && lock.port) {
    try {
      await fetch(`http://localhost:${lock.port}/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      });
      return true;
    } catch {
      // Fallback: force kill
      try { process.kill(lock.pid); return true; } catch { return false; }
    }
  }

  try {
    process.kill(lock.pid, 'SIGTERM');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      logger.error('Cannot stop daemon (PID %d): permission denied. It may be running as a different user.', lock.pid);
    }
    return false;
  }
}

/**
 * Wait for a daemon to stop (PID file gone or process dead).
 */
export async function waitForDaemonStop(dataDir: string, timeoutMs = 5000): Promise<boolean> {
  const pidPath = getPidPath(dataDir);
  const deadline = Date.now() + timeoutMs;
  const interval = 200;

  while (Date.now() < deadline) {
    const lock = readLock(pidPath);
    if (!lock || !isProcessAlive(lock.pid)) return true;
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

/**
 * Get the session token from a running daemon.
 * The daemon exposes it via a file in the data directory.
 */
export async function getDaemonSessionToken(dataDir: string): Promise<string | null> {
  const tokenPath = join(dataDir, 'daemon.token');
  try {
    const { readFileSync } = await import('fs');
    return readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    return null;
  }
}
