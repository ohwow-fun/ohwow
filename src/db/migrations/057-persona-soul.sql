-- Soul Layer: persona observations and cached model
-- Layer 5 of the philosophical architecture (Aristotle's Psyche)

CREATE TABLE IF NOT EXISTS persona_observations (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_persona_obs_type_time
  ON persona_observations(event_type, timestamp);

CREATE TABLE IF NOT EXISTS persona_model (
  id TEXT PRIMARY KEY DEFAULT 'default',
  model TEXT NOT NULL DEFAULT '{}',
  data_points INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);
