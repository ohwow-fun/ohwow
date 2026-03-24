-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN response_type TEXT DEFAULT NULL;

-- @statement
CREATE TABLE IF NOT EXISTS agent_workforce_deliverables (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES agent_workforce_tasks(id),
  agent_id TEXT,
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
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
