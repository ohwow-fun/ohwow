-- Agent Evolution Lifecycle
-- Lifecycle stages, lineage tracking, prompt revision history.

-- 1. Agent lifecycle columns
ALTER TABLE agent_workforce_agents
  ADD COLUMN lifecycle_stage TEXT NOT NULL DEFAULT 'permanent'
    CHECK (lifecycle_stage IN ('ephemeral', 'provisional', 'established', 'permanent', 'archived'));

ALTER TABLE agent_workforce_agents
  ADD COLUMN parent_agent_id TEXT;

ALTER TABLE agent_workforce_agents
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'
    CHECK (origin IN ('user', 'auto_genesis', 'split', 'preset'));

ALTER TABLE agent_workforce_agents
  ADD COLUMN lifecycle_score REAL NOT NULL DEFAULT 0;

ALTER TABLE agent_workforce_agents
  ADD COLUMN promoted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_lifecycle
  ON agent_workforce_agents(workspace_id, lifecycle_stage);

-- 2. Lifecycle event log
CREATE TABLE IF NOT EXISTS agent_workforce_lifecycle_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('created', 'promoted', 'demoted', 'split', 'merged', 'archived', 'prompt_revised', 'unarchived')),
  from_stage TEXT,
  to_stage TEXT,
  reason TEXT,
  metrics TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_events_agent
  ON agent_workforce_lifecycle_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_workspace
  ON agent_workforce_lifecycle_events(workspace_id);

-- 3. Prompt revision history
CREATE TABLE IF NOT EXISTS agent_workforce_prompt_revisions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  system_prompt TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('emergent_skill', 'soul_drift', 'manual', 'split', 'genesis')),
  applied INTEGER NOT NULL DEFAULT 0,
  applied_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prompt_revisions_agent
  ON agent_workforce_prompt_revisions(agent_id);
