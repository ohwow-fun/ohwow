-- Key-value settings table for runtime-level config (e.g. orchestrator voice)
CREATE TABLE IF NOT EXISTS runtime_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- @statement
ALTER TABLE agent_workforce_agents ADD COLUMN voice_profile_id TEXT DEFAULT NULL;
