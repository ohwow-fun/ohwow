-- ============================================================================
-- 070: Data Source Connectors
--
-- Configuration table for external data source connectors (GitHub, local
-- files, Google Drive, etc.) that feed documents into the knowledge base.
-- ============================================================================

CREATE TABLE IF NOT EXISTS data_source_connectors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  sync_interval_minutes INTEGER NOT NULL DEFAULT 30,
  prune_interval_days INTEGER NOT NULL DEFAULT 30,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,
  last_sync_status TEXT,
  last_sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_connectors_workspace
  ON data_source_connectors(workspace_id, enabled);
