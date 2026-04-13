/**
 * Legacy data dir migration
 *
 * Pre-workspace versions of ohwow stored everything in a single directory at
 * ~/.ohwow/data/. The new layout shards data by workspace under
 * ~/.ohwow/workspaces/<name>/. This helper moves the legacy directory to the
 * default workspace location the first time the new daemon boots.
 *
 * Safety:
 *   - Idempotent: skips if the legacy dir doesn't exist or if the target
 *     already does.
 *   - Refuses to run if a daemon is alive on the legacy PID file (returns a
 *     clear error so the user runs `ohwow stop` first).
 *   - Atomic: moves the entire directory with one rename(2) call so we
 *     never end up with split state across both paths.
 *
 * The function does NOT touch custom-named workspaces — it only auto-migrates
 * to `default`, the original single-workspace identity. If the user explicitly
 * boots into a non-default workspace before migrating, the legacy data is
 * left in place and `default` keeps pointing at the legacy paths via the
 * resolver fallback in src/config.ts.
 */

import { existsSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_WORKSPACE,
  LEGACY_DATA_DIR,
  WORKSPACES_DIR,
  resolveActiveWorkspace,
  workspaceLayoutFor,
} from '../config.js';
import { readLock, isProcessAlive } from '../lib/instance-lock.js';
import { logger } from '../lib/logger.js';

/**
 * Move ~/.ohwow/data/ → ~/.ohwow/workspaces/default/ if needed.
 * Throws if a daemon is still alive on the legacy PID file.
 * Returns true if a migration was performed, false if it was a no-op.
 */
export function migrateLegacyDataDirIfNeeded(): boolean {
  // Only auto-migrate when the active workspace is the default. If the user
  // has explicitly selected a different workspace, leave legacy data alone.
  const active = resolveActiveWorkspace();
  if (active.name !== DEFAULT_WORKSPACE) return false;

  const targetLayout = workspaceLayoutFor(DEFAULT_WORKSPACE);

  // Nothing to migrate
  if (!existsSync(join(LEGACY_DATA_DIR, 'runtime.db'))) return false;
  // Already migrated (target exists). The resolver should not be returning
  // legacy paths in this case, so this is a defensive guard.
  if (existsSync(targetLayout.dataDir)) return false;

  // Refuse to migrate while a daemon is alive on the legacy path. Stale PID
  // files are fine — we just check liveness.
  const legacyPid = join(LEGACY_DATA_DIR, 'daemon.pid');
  const lock = readLock(legacyPid);
  if (lock && isProcessAlive(lock.pid)) {
    throw new Error(
      `Cannot migrate ~/.ohwow/data: a daemon is still running (PID ${lock.pid}). ` +
        `Run "ohwow stop" first, then retry.`,
    );
  }

  // Ensure the parent (~/.ohwow/workspaces) exists, then atomic rename.
  mkdirSync(WORKSPACES_DIR, { recursive: true });
  renameSync(LEGACY_DATA_DIR, targetLayout.dataDir);

  logger.info(
    { from: LEGACY_DATA_DIR, to: targetLayout.dataDir },
    '[migration] Moved legacy data dir into workspaces/default',
  );
  return true;
}
