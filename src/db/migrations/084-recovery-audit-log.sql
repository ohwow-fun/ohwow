-- Recovery audit log for structured self-recovery.
-- Tracks error categories, recovery actions, and outcomes for learning.

CREATE TABLE IF NOT EXISTS recovery_audit_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  category TEXT NOT NULL,
  tool_name TEXT,
  error_message TEXT NOT NULL,
  recovery_action TEXT NOT NULL,
  recovered INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recovery_audit_workspace ON recovery_audit_log(workspace_id, created_at);
