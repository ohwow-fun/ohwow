-- Co-Evolution: CORAL-style parallel multi-agent iteration
-- Multiple agents iterate on the same deliverable in parallel rounds,
-- building on each other's attempts via lineage tracking.

-- 1. Evolution runs
CREATE TABLE IF NOT EXISTS agent_workforce_evolution_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  evaluation_criteria TEXT NOT NULL DEFAULT '[]',   -- JSON array
  evaluation_mode TEXT NOT NULL DEFAULT 'llm'
    CHECK (evaluation_mode IN ('llm', 'deterministic', 'hybrid')),
  agent_ids TEXT NOT NULL DEFAULT '[]',             -- JSON array of agent IDs
  max_rounds INTEGER NOT NULL DEFAULT 5,
  budget_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  current_round INTEGER NOT NULL DEFAULT 0,
  best_attempt_id TEXT,
  best_score REAL,
  total_cost_cents INTEGER NOT NULL DEFAULT 0,
  total_attempts INTEGER NOT NULL DEFAULT 0,
  diversity_log TEXT NOT NULL DEFAULT '[]',         -- JSON array
  started_at TEXT,
  completed_at TEXT,
  stopped_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evolution_runs_workspace
  ON agent_workforce_evolution_runs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_evolution_runs_status
  ON agent_workforce_evolution_runs(workspace_id, status);

-- 2. Evolution attempts
CREATE TABLE IF NOT EXISTS agent_workforce_evolution_attempts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_id TEXT NOT NULL REFERENCES agent_workforce_evolution_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  parent_attempt_id TEXT REFERENCES agent_workforce_evolution_attempts(id) ON DELETE SET NULL,
  parent_agent_id TEXT,
  task_id TEXT,
  deliverable TEXT,
  strategy_summary TEXT,
  score REAL,
  score_breakdown TEXT,        -- JSON object
  truth_score INTEGER,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evo_attempts_run
  ON agent_workforce_evolution_attempts(run_id, round, score DESC);
CREATE INDEX IF NOT EXISTS idx_evo_attempts_agent
  ON agent_workforce_evolution_attempts(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evo_attempts_lineage
  ON agent_workforce_evolution_attempts(parent_attempt_id);
