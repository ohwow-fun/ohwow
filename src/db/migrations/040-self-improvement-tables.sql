-- Self-Improvement Tables (E13-E27)
-- Supports the self-improvement subsystem: routing stats, skills,
-- principles, digital twin, practice sessions, discovered processes,
-- proactive runs, and action journal.

-- E14: Thompson Sampling routing stats
CREATE TABLE IF NOT EXISTS agent_workforce_routing_stats (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  success_rate REAL NOT NULL DEFAULT 0,
  avg_truth_score REAL DEFAULT 0,
  avg_cost_cents REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, agent_id, task_type)
);
CREATE INDEX IF NOT EXISTS idx_routing_stats_workspace ON agent_workforce_routing_stats(workspace_id, task_type);

-- E22: Synthesized skills
CREATE TABLE IF NOT EXISTS agent_workforce_skills (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  skill_type TEXT NOT NULL DEFAULT 'procedure',
  source_type TEXT NOT NULL DEFAULT 'synthesized',
  definition TEXT NOT NULL DEFAULT '{}',
  agent_ids TEXT NOT NULL DEFAULT '[]',
  pattern_support INTEGER DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_skills_workspace ON agent_workforce_skills(workspace_id, is_active);

-- E24: Digital twin causal model snapshots
CREATE TABLE IF NOT EXISTS agent_workforce_digital_twin_snapshots (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  causal_graph TEXT NOT NULL DEFAULT '{}',
  metrics_snapshot TEXT NOT NULL DEFAULT '[]',
  confidence REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_twin_snapshots_workspace ON agent_workforce_digital_twin_snapshots(workspace_id, created_at DESC);

-- E25: Practice sessions
CREATE TABLE IF NOT EXISTS agent_workforce_practice_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  source_task_id TEXT,
  scenario TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  verification_score REAL,
  learnings_extracted INTEGER DEFAULT 0,
  cost_cents REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_practice_workspace ON agent_workforce_practice_sessions(workspace_id, agent_id);

-- E26: Strategic principles
CREATE TABLE IF NOT EXISTS agent_workforce_principles (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  agent_id TEXT,
  rule TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'strategy',
  confidence REAL NOT NULL DEFAULT 0,
  utility_score REAL NOT NULL DEFAULT 0,
  source_memory_ids TEXT NOT NULL DEFAULT '[]',
  times_applied INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_principles_workspace ON agent_workforce_principles(workspace_id, is_active);

-- E27: Discovered processes
CREATE TABLE IF NOT EXISTS agent_workforce_discovered_processes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  steps TEXT NOT NULL DEFAULT '[]',
  frequency INTEGER NOT NULL DEFAULT 0,
  avg_duration_ms INTEGER DEFAULT 0,
  involved_agent_ids TEXT NOT NULL DEFAULT '[]',
  confidence REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'discovered',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_discovered_processes_workspace ON agent_workforce_discovered_processes(workspace_id, status);

-- E21: Proactive task engine run log
CREATE TABLE IF NOT EXISTS agent_workforce_proactive_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  signals_evaluated INTEGER NOT NULL DEFAULT 0,
  tasks_created INTEGER NOT NULL DEFAULT 0,
  tasks_skipped INTEGER NOT NULL DEFAULT 0,
  skip_reasons TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_proactive_runs_workspace ON agent_workforce_proactive_runs(workspace_id, created_at DESC);
