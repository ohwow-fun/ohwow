-- State change audit log for tracking all set/delete operations on agent state.
-- Enables debugging, rollback analysis, and compliance auditing for long-running workflows.

CREATE TABLE IF NOT EXISTS agent_workforce_state_changelog (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('set', 'delete')),
  scope TEXT NOT NULL DEFAULT 'agent',
  scope_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_changelog_agent ON agent_workforce_state_changelog(workspace_id, agent_id);
