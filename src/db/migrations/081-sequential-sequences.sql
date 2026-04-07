-- Sequential Multi-Agent Coordination
-- Execution runs for the Sequential protocol.

CREATE TABLE IF NOT EXISTS agent_workforce_sequence_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_prompt TEXT,
  steps TEXT NOT NULL DEFAULT '[]',      -- JSON array of SequenceStep
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  step_results TEXT NOT NULL DEFAULT '[]', -- JSON array of SequenceStepResult
  total_cost_cents INTEGER NOT NULL DEFAULT 0,
  participated_count INTEGER NOT NULL DEFAULT 0,
  abstained_count INTEGER NOT NULL DEFAULT 0,
  final_output TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sequence_runs_workspace
  ON agent_workforce_sequence_runs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sequence_runs_status
  ON agent_workforce_sequence_runs(workspace_id, status);
