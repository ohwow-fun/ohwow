-- Async chat: status tracking on orchestrator_conversations.
--
-- The MCP ohwow_chat tool now creates a conversation row, returns its id
-- immediately, and dispatches the orchestrator turn in the background so
-- long turns survive client disconnects. Clients poll GET /api/chat/:id
-- until status flips out of 'running'.
--
-- Status values:
--   idle    — conversation exists, no turn currently executing (manual create)
--   running — orchestrator turn dispatched, in flight
--   done    — turn finished, latest assistant message is the final answer
--   error   — turn failed, last_error has the message
--
-- The partial index on status='running' keeps "find in-flight turns" cheap
-- without bloating the index for the 99% steady-state case.

ALTER TABLE orchestrator_conversations
  ADD COLUMN status TEXT NOT NULL DEFAULT 'idle';

ALTER TABLE orchestrator_conversations
  ADD COLUMN last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_conv_status_running
  ON orchestrator_conversations(workspace_id, status)
  WHERE status = 'running';
