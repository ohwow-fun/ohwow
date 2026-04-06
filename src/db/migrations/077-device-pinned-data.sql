-- Device-pinned data: manifest of what data each device holds exclusively.
-- Syncs metadata everywhere; actual data stays on the owning device.

CREATE TABLE IF NOT EXISTS device_data_manifest (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  data_type TEXT NOT NULL,            -- 'memory' | 'conversation' | 'knowledge_doc' | 'file' | 'credential'
  data_id TEXT NOT NULL,              -- FK to the actual data row
  title TEXT NOT NULL,                -- searchable summary (never the actual content)
  tags TEXT DEFAULT '[]',             -- JSON array of keyword tags
  size_bytes INTEGER DEFAULT 0,
  access_policy TEXT NOT NULL DEFAULT 'ephemeral',  -- 'ephemeral' | 'cached_1h' | 'cached_24h' | 'never_cache'
  requires_approval INTEGER NOT NULL DEFAULT 0,
  owner_user_id TEXT,
  pinned_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_fetched_at TEXT,
  fetch_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_manifest_data
  ON device_data_manifest(workspace_id, data_id, device_id);
CREATE INDEX IF NOT EXISTS idx_manifest_workspace
  ON device_data_manifest(workspace_id);
CREATE INDEX IF NOT EXISTS idx_manifest_type
  ON device_data_manifest(data_type, workspace_id);

-- Locality policy on existing tables
ALTER TABLE agent_workforce_agent_memory
  ADD COLUMN locality_policy TEXT NOT NULL DEFAULT 'sync';

ALTER TABLE orchestrator_conversations
  ADD COLUMN locality_policy TEXT NOT NULL DEFAULT 'sync';

-- Fetch approval queue
CREATE TABLE IF NOT EXISTS data_fetch_approvals (
  id TEXT PRIMARY KEY,
  manifest_entry_id TEXT NOT NULL REFERENCES device_data_manifest(id),
  requesting_device_id TEXT NOT NULL,
  requesting_device_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  responded_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
