-- 018-workspace-onboarding.sql
-- Workspace-level data collected during onboarding (business info, founder stage).
-- Stores onboarding context for agent recommendations and personalization.

CREATE TABLE IF NOT EXISTS agent_workforce_workspaces (
  id TEXT PRIMARY KEY,
  business_name TEXT,
  business_type TEXT,
  business_description TEXT,
  founder_path TEXT,
  founder_focus TEXT,
  growth_stage TEXT,
  onboarding_complete INTEGER NOT NULL DEFAULT 0,
  timezone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed a default local workspace row
INSERT OR IGNORE INTO agent_workforce_workspaces (id) VALUES ('local');
