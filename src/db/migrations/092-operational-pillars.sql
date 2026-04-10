-- Operational Pillars: what a business SHOULD be doing at each stage
-- Global reference table + per-workspace instance tracking

CREATE TABLE IF NOT EXISTS agent_workforce_operational_pillars (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'acquisition', 'retention', 'operations', 'finance', 'product', 'team', 'strategy'
  )),
  icon TEXT NOT NULL DEFAULT 'circle',
  business_types TEXT NOT NULL DEFAULT '[]',       -- JSON array of business types
  min_stage INTEGER NOT NULL DEFAULT 0,
  max_stage INTEGER NOT NULL DEFAULT 9,
  priority_by_stage TEXT NOT NULL DEFAULT '{}',    -- JSON: { "0": "critical", "1": "important" }
  kpis TEXT NOT NULL DEFAULT '[]',                 -- JSON array
  best_practices TEXT NOT NULL DEFAULT '[]',       -- JSON array
  setup_steps TEXT NOT NULL DEFAULT '[]',          -- JSON array
  estimated_setup_hours REAL DEFAULT 1,
  prerequisite_pillar_ids TEXT DEFAULT '[]',       -- JSON array of IDs
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_workforce_pillar_instances (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES agent_workforce_workspaces(id) ON DELETE CASCADE,
  pillar_id TEXT NOT NULL REFERENCES agent_workforce_operational_pillars(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN (
    'not_started', 'suggested', 'building', 'running', 'optimizing', 'paused', 'dismissed'
  )),
  mode TEXT NOT NULL DEFAULT 'builder' CHECK (mode IN ('builder', 'optimizer')),
  health_score REAL DEFAULT 0 CHECK (health_score >= 0 AND health_score <= 1),
  last_health_check TEXT,
  health_details TEXT DEFAULT '{}',
  agent_ids TEXT DEFAULT '[]',
  automation_ids TEXT DEFAULT '[]',
  schedule_cron TEXT,
  blueprint TEXT DEFAULT NULL,
  blueprint_approved_at TEXT,
  total_tasks_completed INTEGER DEFAULT 0,
  total_cost_cents INTEGER DEFAULT 0,
  estimated_hours_saved REAL DEFAULT 0,
  suggested_at TEXT,
  building_started_at TEXT,
  running_since TEXT,
  last_activity_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, pillar_id)
);

CREATE INDEX IF NOT EXISTS idx_pillar_instances_workspace ON agent_workforce_pillar_instances(workspace_id);
CREATE INDEX IF NOT EXISTS idx_pillar_instances_status ON agent_workforce_pillar_instances(workspace_id, status);
