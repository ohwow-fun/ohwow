-- Cross-task state store: persistent key-value state per agent/schedule/goal
-- Enables agents to maintain structured state across task runs (e.g. "12/30 posts done")

CREATE TABLE IF NOT EXISTS agent_workforce_task_state (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'agent',
  scope_id TEXT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_state_lookup
  ON agent_workforce_task_state(workspace_id, agent_id, scope, scope_id, key);

CREATE INDEX IF NOT EXISTS idx_task_state_agent
  ON agent_workforce_task_state(workspace_id, agent_id);
