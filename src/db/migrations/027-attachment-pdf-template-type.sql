-- Add 'pdf_template' to entity_type CHECK constraint on agent_workforce_attachments.
-- SQLite doesn't support ALTER CHECK, so recreate the table.

CREATE TABLE IF NOT EXISTS agent_workforce_attachments_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('contact', 'task', 'plan_step', 'pdf_template')),
  entity_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  storage_path TEXT NOT NULL,
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO agent_workforce_attachments_new SELECT * FROM agent_workforce_attachments;
DROP TABLE IF EXISTS agent_workforce_attachments;
ALTER TABLE agent_workforce_attachments_new RENAME TO agent_workforce_attachments;

CREATE INDEX IF NOT EXISTS idx_workforce_attachments_workspace
  ON agent_workforce_attachments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workforce_attachments_entity
  ON agent_workforce_attachments(entity_type, entity_id);
