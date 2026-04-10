-- Goal checkpoints: automatically detected conversational goals with lifecycle tracking.
-- Goals carry across sessions for cross-conversation continuity.

CREATE TABLE IF NOT EXISTS orchestrator_goal_checkpoints (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  goal_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'achieved', 'abandoned', 'deferred')),
  context_snapshot TEXT,       -- JSON: key decisions/facts at checkpoint time
  achieved_at TEXT,
  message_index INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_goal_checkpoints_workspace_status
  ON orchestrator_goal_checkpoints(workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_goal_checkpoints_conversation
  ON orchestrator_goal_checkpoints(conversation_id);
