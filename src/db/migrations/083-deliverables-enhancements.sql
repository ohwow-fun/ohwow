-- Enhance deliverables: make task_id nullable (for chat deliverables),
-- add session_id (link to orchestrator chat), add auto_created flag.

-- @statement
CREATE TABLE IF NOT EXISTS agent_workforce_deliverables_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  task_id TEXT REFERENCES agent_workforce_tasks(id),
  agent_id TEXT,
  session_id TEXT,
  deliverable_type TEXT NOT NULL,
  provider TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  delivery_result TEXT,
  delivered_at TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  rejection_reason TEXT,
  retry_of_deliverable_id TEXT,
  auto_created INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- @statement
INSERT INTO agent_workforce_deliverables_new (
  id, workspace_id, task_id, agent_id, session_id,
  deliverable_type, provider, title, content, status,
  delivery_result, delivered_at, reviewed_by, reviewed_at,
  rejection_reason, retry_of_deliverable_id, auto_created,
  created_at, updated_at
)
SELECT
  id, workspace_id, task_id, agent_id, NULL,
  deliverable_type, provider, title, content, status,
  delivery_result, delivered_at, reviewed_by, reviewed_at,
  rejection_reason, retry_of_deliverable_id, 0,
  created_at, updated_at
FROM agent_workforce_deliverables;

-- @statement
DROP TABLE agent_workforce_deliverables;

-- @statement
ALTER TABLE agent_workforce_deliverables_new RENAME TO agent_workforce_deliverables;
