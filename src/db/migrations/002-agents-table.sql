-- Local Runtime: Agents table (mirrors cloud schema for service compatibility)
-- This allows shared services to query agent_workforce_agents locally.

CREATE TABLE IF NOT EXISTS agent_workforce_agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  department_id TEXT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT,
  avatar_url TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}', -- JSON
  status TEXT NOT NULL DEFAULT 'idle',
  stats TEXT NOT NULL DEFAULT '{}', -- JSON
  is_preset INTEGER NOT NULL DEFAULT 0,
  a2a_published INTEGER NOT NULL DEFAULT 0,
  a2a_skills TEXT NOT NULL DEFAULT '[]', -- JSON
  memory_document TEXT,
  memory_token_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agent_workforce_agents(workspace_id);

-- Activity log table (for rpc compatibility)
CREATE TABLE IF NOT EXISTS agent_workforce_activity (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  agent_id TEXT,
  task_id TEXT,
  metadata TEXT DEFAULT '{}', -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_workspace ON agent_workforce_activity(workspace_id);
