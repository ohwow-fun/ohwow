-- Agent OS: Digital Twin Sandbox Tables

CREATE TABLE IF NOT EXISTS agent_workforce_tool_recordings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input TEXT NOT NULL DEFAULT '{}',
  tool_output TEXT NOT NULL DEFAULT '',
  is_error INTEGER DEFAULT 0,
  input_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_recordings_lookup
  ON agent_workforce_tool_recordings(agent_id, tool_name, input_hash);

CREATE TABLE IF NOT EXISTS agent_workforce_shadow_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  shadow_config TEXT NOT NULL DEFAULT '{}',
  tasks_evaluated INTEGER DEFAULT 0,
  production_metrics TEXT DEFAULT '{}',
  shadow_metrics TEXT DEFAULT '{}',
  verdict TEXT NOT NULL DEFAULT 'needs_review',
  confidence_score REAL DEFAULT 0,
  regressions TEXT DEFAULT '[]',
  cost_cents REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shadow_runs_agent
  ON agent_workforce_shadow_runs(agent_id, created_at DESC);
