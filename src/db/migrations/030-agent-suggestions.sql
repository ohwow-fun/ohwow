-- Agent workforce: agent suggestions table for gap analysis (SQLite)

CREATE TABLE IF NOT EXISTS agent_workforce_agent_suggestions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  workspace_id TEXT NOT NULL REFERENCES agent_workforce_workspaces(id) ON DELETE CASCADE,

  gap_type TEXT NOT NULL CHECK (gap_type IN (
    'task_fallback',
    'overloaded_agent',
    'failed_domain',
    'growth_stage_gap',
    'department_gap',
    'goal_coverage_gap'
  )),

  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  suggested_role TEXT NOT NULL,
  suggested_department TEXT,
  preset_id TEXT,

  evidence TEXT DEFAULT '{}',

  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dismissed', 'created')),

  created_at TEXT DEFAULT (datetime('now')),
  dismissed_at TEXT,
  created_agent_id TEXT REFERENCES agent_workforce_agents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_suggestions_workspace ON agent_workforce_agent_suggestions(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_suggestions_active ON agent_workforce_agent_suggestions(workspace_id, status);
