-- Homeostasis: Self-regulation with set points (Cannon + Ashby)
-- Negative feedback loops and allostatic adaptation

CREATE TABLE IF NOT EXISTS homeostasis_set_points (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  target REAL NOT NULL,
  tolerance REAL NOT NULL DEFAULT 0.1,
  adaptation_rate REAL NOT NULL DEFAULT 0.1,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, metric)
);

CREATE TABLE IF NOT EXISTS allostasis_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  old_target REAL NOT NULL,
  new_target REAL NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_allostasis_events_time ON allostasis_events(workspace_id, created_at DESC);
