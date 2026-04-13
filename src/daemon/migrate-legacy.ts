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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_WORKSPACE,
  LEGACY_DATA_DIR,
  WORKSPACES_DIR,
  resolveActiveWorkspace,
  workspaceLayoutFor,
} from '../config.js';
import { readLock, isProcessAlive } from '../lib/instance-lock.js';
import { logger } from '../lib/logger.js';

/**
 * Pre-workspace installs sometimes have an explicit `dbPath` field in
 * ~/.ohwow/config.json pinning the legacy runtime.db. After the migration,
 * that path no longer exists — but loadConfig's precedence (env > fileConfig
 * > resolver) would still return the dead path, causing initDatabase to
 * silently create a fresh empty DB at the legacy location. We rewrite the
 * config to drop the stale field so the resolver takes over.
 *
 * Only touches dbPath when it exactly matches the legacy runtime.db path. Any
 * other custom value is left alone (the user clearly wants it).
 */
function stripStaleLegacyDbPathFromConfig(): void {
  if (!existsSync(DEFAULT_CONFIG_PATH)) return;
  const legacyDbPath = join(LEGACY_DATA_DIR, 'runtime.db');
  let raw: string;
  try {
    raw = readFileSync(DEFAULT_CONFIG_PATH, 'utf-8');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      '[migration] Could not read config.json to clear stale dbPath',
    );
    return;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      '[migration] config.json is malformed; leaving dbPath alone',
    );
    return;
  }
  if (parsed.dbPath !== legacyDbPath) return;
  delete parsed.dbPath;
  try {
    writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(parsed, null, 2));
    logger.info('[migration] Removed stale legacy dbPath from config.json');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      '[migration] Failed to rewrite config.json',
    );
  }
}

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

  // Also strip an obsolete pinned dbPath from config.json so the resolver
  // takes over for the next loadConfig() call. Without this, loadConfig's
  // fileConfig.dbPath fallback would return the now-vanished legacy path and
  // initDatabase would silently create a fresh empty DB there.
  stripStaleLegacyDbPathFromConfig();

  return true;
}
