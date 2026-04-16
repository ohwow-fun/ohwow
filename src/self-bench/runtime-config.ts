/**
 * Runtime config overrides — reversible key-value store.
 *
 * Phase 5-B. Experiments that want to change a configuration value
 * at runtime (without a code deploy) write to this table through
 * setRuntimeConfig(). Consumers read via getRuntimeConfig() with a
 * fallback default. A module-level cache mirrors the table so
 * hot-path reads don't hit SQLite.
 *
 * The cache is refreshed:
 *   - On daemon boot (via refreshRuntimeConfigCache called from
 *     start.ts)
 *   - On an interval (every 60s) via the same refresher
 *   - Locally on every setRuntimeConfig / deleteRuntimeConfig call
 *     so an experiment's own write is immediately visible
 *
 * Rollback pattern: an experiment's intervene() calls
 * setRuntimeConfig to apply the change. Its rollback() calls
 * deleteRuntimeConfig with the same key to revert. The
 * InterventionApplied.details captured by intervene stores the
 * original default + the new value, so rollback() could also
 * re-apply the default instead of deleting, depending on semantics.
 *
 * Safe with a no-DB fallback: if refreshRuntimeConfigCache hasn't
 * run yet, getRuntimeConfig returns the caller's fallback without
 * hitting the DB. This keeps the hot path from needing any db
 * handle and lets experiments test-only their logic without a db
 * reference.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

/** How often the cache is refreshed from the table in production. */
export const RUNTIME_CONFIG_REFRESH_INTERVAL_MS = 60 * 1000;

interface CacheEntry {
  value: unknown;
  setBy: string | null;
  findingId: string | null;
  setAt: string;
}

// Module-level cache. Populated by refreshRuntimeConfigCache, read
// synchronously by getRuntimeConfig. Tests can reset via
// _resetRuntimeConfigCacheForTests.
const cache = new Map<string, CacheEntry>();
let lastRefreshAt = 0;

/** Test hook — resets the module cache so tests start clean. */
export function _resetRuntimeConfigCacheForTests(): void {
  cache.clear();
  lastRefreshAt = 0;
}

/**
 * Test hook — seeds a value directly into the in-memory cache without
 * going through setRuntimeConfig's DB write. Lets tests exercise
 * consumers (e.g. the experiment-author ranker) without wiring a mock
 * adapter that supports `.delete().eq()` chaining.
 */
export function _seedRuntimeConfigCacheForTests(key: string, value: unknown): void {
  cache.set(key, {
    value,
    setBy: 'test',
    findingId: null,
    setAt: new Date().toISOString(),
  });
}

/** Direct cache read for tests/diagnostics. */
export function getRuntimeConfigCacheSnapshot(): Array<{
  key: string;
  value: unknown;
  setBy: string | null;
  findingId: string | null;
  setAt: string;
}> {
  return Array.from(cache.entries()).map(([key, entry]) => ({ key, ...entry }));
}

/**
 * Synchronously read a runtime config value. Returns the cached
 * value if present, otherwise the fallback. Never throws. Never
 * touches the DB — readers use the fallback when the cache hasn't
 * been populated yet (daemon boot race), which is the intended
 * behavior.
 */
export function getRuntimeConfig<T>(key: string, fallback: T): T {
  const entry = cache.get(key);
  if (!entry) return fallback;
  return entry.value as T;
}

/**
 * Write a runtime config value. Updates the DB AND the local cache
 * synchronously on success. Logs + swallows errors so a config
 * write failure never breaks the calling experiment — the rollback
 * hook is how failed writes are observed, not throws.
 */
export async function setRuntimeConfig(
  db: DatabaseAdapter,
  key: string,
  value: unknown,
  meta?: { setBy?: string; findingId?: string },
): Promise<void> {
  const now = new Date().toISOString();
  const serialized = JSON.stringify(value);
  try {
    // Upsert via delete+insert. A proper adapter would use
    // INSERT ... ON CONFLICT but the DatabaseAdapter interface
    // doesn't expose that — two statements here are fine since
    // the table has a PRIMARY KEY on key.
    await db.from('runtime_config_overrides').delete().eq('key', key);
    await db.from('runtime_config_overrides').insert({
      key,
      value: serialized,
      set_by: meta?.setBy ?? null,
      finding_id: meta?.findingId ?? null,
      set_at: now,
      updated_at: now,
    });

    cache.set(key, {
      value,
      setBy: meta?.setBy ?? null,
      findingId: meta?.findingId ?? null,
      setAt: now,
    });
  } catch (err) {
    logger.warn({ err, key }, '[runtime-config] setRuntimeConfig failed');
  }
}

/**
 * Delete a runtime config override, reverting to the caller's
 * fallback. Updates both the DB and the local cache on success.
 * Swallows errors like setRuntimeConfig.
 */
export async function deleteRuntimeConfig(
  db: DatabaseAdapter,
  key: string,
): Promise<void> {
  try {
    await db.from('runtime_config_overrides').delete().eq('key', key);
    cache.delete(key);
  } catch (err) {
    logger.warn({ err, key }, '[runtime-config] deleteRuntimeConfig failed');
  }
}

/**
 * Refresh the module-level cache from the DB. Called on daemon
 * boot AND on a 60-second interval. Swallows errors — a refresh
 * failure keeps the previous cache in place so reads continue to
 * work.
 */
export async function refreshRuntimeConfigCache(db: DatabaseAdapter): Promise<void> {
  try {
    const { data } = await db
      .from<{ key: string; value: string; set_by: string | null; finding_id: string | null; set_at: string }>(
        'runtime_config_overrides',
      )
      .select('key, value, set_by, finding_id, set_at');
    const rows = (data ?? []) as Array<{
      key: string;
      value: string | unknown;
      set_by: string | null;
      finding_id: string | null;
      set_at: string;
    }>;

    // Parse each row's value. Some adapters return TEXT JSON
    // pre-parsed; handle both shapes.
    const next = new Map<string, CacheEntry>();
    for (const row of rows) {
      let parsed: unknown = row.value;
      if (typeof row.value === 'string') {
        try {
          parsed = JSON.parse(row.value);
        } catch {
          parsed = row.value; // fall back to raw string
        }
      }
      next.set(row.key, {
        value: parsed,
        setBy: row.set_by,
        findingId: row.finding_id,
        setAt: row.set_at,
      });
    }

    // Atomic swap
    cache.clear();
    for (const [k, v] of next) cache.set(k, v);
    lastRefreshAt = Date.now();
  } catch (err) {
    logger.warn({ err }, '[runtime-config] refresh failed, keeping previous cache');
  }
}

/** When the cache was last refreshed from the DB (epoch ms). */
export function getRuntimeConfigLastRefreshAt(): number {
  return lastRefreshAt;
}
