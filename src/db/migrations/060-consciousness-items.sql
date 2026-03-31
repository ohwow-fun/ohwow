-- Consciousness Items — Shared consciousness between local and cloud.
-- Schema matches the cloud's consciousness_items Supabase table.
-- Categories: alert, insight, prediction, milestone, anomaly
-- Local workspace types map to cloud categories:
--   failure/warning → alert
--   discovery/pattern → insight
--   skill → milestone
--   signal → prediction

CREATE TABLE IF NOT EXISTS consciousness_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  salience REAL NOT NULL DEFAULT 0.5,
  category TEXT NOT NULL CHECK (category IN ('alert', 'insight', 'prediction', 'milestone', 'anomaly')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at TEXT,
  origin TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local', 'cloud'))
);

CREATE INDEX IF NOT EXISTS idx_consciousness_items_workspace
  ON consciousness_items(workspace_id, category);
CREATE INDEX IF NOT EXISTS idx_consciousness_items_salience
  ON consciousness_items(workspace_id, salience DESC);
