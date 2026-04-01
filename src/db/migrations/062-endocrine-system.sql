-- Endocrine System: Hormone snapshots (Spinoza's conatus)
-- Global state modulator crossing all architectural boundaries

CREATE TABLE IF NOT EXISTS hormone_snapshots (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hormone_snapshots_time ON hormone_snapshots(workspace_id, created_at DESC);
