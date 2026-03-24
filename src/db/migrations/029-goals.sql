-- Goals: Strategic objective tracking for task context ancestry

CREATE TABLE IF NOT EXISTS agent_workforce_goals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  target_metric TEXT,
  target_value REAL,
  current_value REAL DEFAULT 0,
  unit TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  priority TEXT NOT NULL DEFAULT 'normal',
  due_date TEXT,
  completed_at TEXT,
  color TEXT NOT NULL DEFAULT '#6366f1',
  icon TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_goals_workspace_status ON agent_workforce_goals(workspace_id, status);

ALTER TABLE agent_workforce_tasks ADD COLUMN goal_id TEXT;
ALTER TABLE agent_workforce_projects ADD COLUMN goal_id TEXT;
