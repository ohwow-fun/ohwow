-- ============================================================================
-- 023: Local File Access
--
-- Adds per-agent directory allowlists for read-only filesystem access.
-- Agents can read files from configured directories during task execution.
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_file_access_paths (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, path)
);

CREATE INDEX IF NOT EXISTS idx_file_access_agent
  ON agent_file_access_paths(agent_id);
