-- Conversation digests: LLM-distilled summaries of older conversation segments.
-- Part of the tiered context system: hot (recent messages) → warm (digests) → cold (memories).

CREATE TABLE IF NOT EXISTS orchestrator_conversation_digests (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  segment_start_idx INTEGER NOT NULL,
  segment_end_idx INTEGER NOT NULL,
  digest TEXT NOT NULL DEFAULT '{}',  -- JSON: { decisions, facts, goals, toolOutcomes, openQuestions, summary }
  token_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conv_digests_conversation
  ON orchestrator_conversation_digests(conversation_id);

CREATE INDEX IF NOT EXISTS idx_conv_digests_workspace
  ON orchestrator_conversation_digests(workspace_id);
