CREATE TABLE IF NOT EXISTS document_processing_queue (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, processing, done, failed
  payload TEXT NOT NULL DEFAULT '{}',       -- JSON: { source_type, file_path?, url?, ... }
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_doc_queue_status
  ON document_processing_queue(status, created_at);

CREATE INDEX IF NOT EXISTS idx_doc_queue_workspace
  ON document_processing_queue(workspace_id);
