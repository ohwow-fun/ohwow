-- 016-dashboard-tables.sql
-- Additional tables needed by the web dashboard init endpoint.
-- Contacts and revenue already exist (010-local-crm.sql).

CREATE TABLE IF NOT EXISTS agent_workforce_departments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_departments_workspace ON agent_workforce_departments(workspace_id);

CREATE TABLE IF NOT EXISTS agent_workforce_team_members (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT,
  start_date TEXT,
  skills TEXT DEFAULT '[]',
  capacity_hours INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_team_members_workspace ON agent_workforce_team_members(workspace_id);

CREATE TABLE IF NOT EXISTS agent_workforce_custom_roadmap_stages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  stage_id INTEGER NOT NULL,
  tagline TEXT,
  focus_areas TEXT DEFAULT '[]',
  key_metrics TEXT DEFAULT '[]',
  next_milestone TEXT,
  priority TEXT,
  priority_description TEXT,
  quick_actions TEXT DEFAULT '[]',
  generated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_custom_roadmap_workspace ON agent_workforce_custom_roadmap_stages(workspace_id);
