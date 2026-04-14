-- =====================================================================
-- Migration 119: runtime_config_overrides — reversible config at runtime
--
-- Phase 5-B: key-value store for config values that an experiment
-- can change at runtime and roll back if validation fails. Used by
-- the upcoming tuner experiments (Phase 5-C) that adjust thresholds
-- like STALE_THRESHOLD_MS based on observed ledger patterns.
--
-- Design
-- ------
-- Every entry has:
--   - key          — opaque string, by convention namespaced with a
--                    dot (e.g. "stale_task_cleanup.threshold_ms")
--   - value        — JSON-serialized value, parsed by the consumer
--   - set_by       — experiment_id that wrote this entry (for audit)
--   - finding_id   — the finding row that captured the decision,
--                    so rollbacks can link back to the original
--                    intervention
--   - set_at       — ISO timestamp
--
-- Consumers pattern:
--   const threshold = await getRuntimeConfig(db, 'stale_task_cleanup.threshold_ms', DEFAULT);
-- Writers pattern (inside intervene):
--   await setRuntimeConfig(db, 'key', newValue, { setBy: exp.id, findingId });
-- Rollback pattern (inside rollback):
--   await deleteRuntimeConfig(db, 'key'); // reverts to caller's default
--
-- A module-level cache mirrors the table so hot-path reads don't hit
-- SQLite. Cache is refreshed on daemon boot + every 60s + on every
-- set/delete (local invalidation).
-- =====================================================================

-- @statement
CREATE TABLE IF NOT EXISTS runtime_config_overrides (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  set_by TEXT,
  finding_id TEXT,
  set_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_runtime_config_set_by
  ON runtime_config_overrides(set_by, set_at DESC);
