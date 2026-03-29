-- Add target_type and target_id to orchestrator_chat_sessions
-- Enables per-agent and orchestrator conversations in the Messages inbox

ALTER TABLE orchestrator_chat_sessions ADD COLUMN target_type TEXT NOT NULL DEFAULT 'orchestrator';
ALTER TABLE orchestrator_chat_sessions ADD COLUMN target_id TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_orchestrator_sessions_target
  ON orchestrator_chat_sessions(workspace_id, target_type, target_id, updated_at DESC);
