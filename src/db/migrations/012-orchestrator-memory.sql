CREATE TABLE IF NOT EXISTS orchestrator_memory (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  memory_type TEXT NOT NULL CHECK (memory_type IN ('preference', 'pattern', 'context', 'correction')),
  content TEXT NOT NULL,
  source_session_id TEXT,
  relevance_score REAL NOT NULL DEFAULT 0.5,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orch_memory_workspace ON orchestrator_memory(workspace_id);
CREATE INDEX IF NOT EXISTS idx_orch_memory_active ON orchestrator_memory(workspace_id, is_active);
