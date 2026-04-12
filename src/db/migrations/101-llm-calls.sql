-- Shape C telemetry: per-call record of every llm organ invocation.
--
-- Every runLlmCall writes a row here, success or failure, with the
-- resolved provider, model, token counts, cost, and latency. Feeds
-- future adaptive routing (routingHistory, bandit model selection) and
-- lets operators see cost per agent per purpose over time.
--
-- Nullable agent_id: llm calls can come from orchestrator chat (no
-- specific agent) or from external callers via /api/llm.
-- Nullable task_id: llm calls may be ad-hoc outside any task.

CREATE TABLE IF NOT EXISTS llm_calls (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  agent_id        TEXT,
  task_id         TEXT,
  purpose         TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_cents      INTEGER NOT NULL DEFAULT 0,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  success         INTEGER NOT NULL DEFAULT 1,
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS llm_calls_workspace_created_idx
  ON llm_calls(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS llm_calls_agent_idx
  ON llm_calls(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS llm_calls_purpose_idx
  ON llm_calls(purpose, created_at DESC);
