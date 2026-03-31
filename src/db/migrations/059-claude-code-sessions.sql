-- Claude Code CLI session persistence for --resume support
-- Stores session IDs per agent with working directory awareness

-- @statement
CREATE TABLE IF NOT EXISTS claude_code_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  claude_session_id TEXT NOT NULL,
  working_directory TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'stale', 'failed'))
);

-- @statement
CREATE INDEX IF NOT EXISTS idx_cc_sessions_agent
  ON claude_code_sessions(agent_id, status);
