-- =====================================================================
-- Migration 051: Execution Engine Tables
-- Add 6 tables needed for local feature parity with cloud service layer
-- =====================================================================

-- 1. Workflow Runs (workflow-execution.service.ts)
-- @statement
CREATE TABLE IF NOT EXISTS agent_workforce_workflow_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workflow_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled')),
  current_step_index INTEGER DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0,
  step_results TEXT DEFAULT '[]',
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  failed_step_index INTEGER,
  checkpoint TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON agent_workforce_workflow_runs(workflow_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workspace ON agent_workforce_workflow_runs(workspace_id, status);

-- 2. Sessions (session.service.ts — cross-task context)
-- @statement
CREATE TABLE IF NOT EXISTS agent_workforce_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  title TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  last_active_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  context_summary TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','expired','closed'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_sessions_agent_active ON agent_workforce_sessions(agent_id, status);
-- @statement
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON agent_workforce_sessions(workspace_id);

-- 3. Action Journal (action-journal.service.ts — tool reversibility)
-- @statement
CREATE TABLE IF NOT EXISTS agent_workforce_action_journal (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  agent_id TEXT,
  task_id TEXT,
  tool_name TEXT NOT NULL,
  tool_input TEXT DEFAULT '{}',
  tool_output TEXT DEFAULT '{}',
  reversibility TEXT DEFAULT 'reversible',
  compensating_action TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_action_journal_workspace ON agent_workforce_action_journal(workspace_id, created_at DESC);
-- @statement
CREATE INDEX IF NOT EXISTS idx_action_journal_task ON agent_workforce_action_journal(task_id, created_at DESC);
-- @statement
CREATE INDEX IF NOT EXISTS idx_action_journal_active ON agent_workforce_action_journal(status);

-- 4. Autonomy History (autonomy-history.service.ts — auto-graduation)
-- @statement
CREATE TABLE IF NOT EXISTS agent_workforce_autonomy_history (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  autonomy_level INTEGER NOT NULL CHECK (autonomy_level BETWEEN 1 AND 5),
  decision TEXT NOT NULL CHECK (decision IN ('executed','escalated','self_corrected','chained')),
  escalation_reason TEXT,
  truth_score INTEGER,
  anomaly_detected INTEGER DEFAULT 0,
  tool_names TEXT DEFAULT '[]',
  cost_cents REAL DEFAULT 0,
  outcome TEXT CHECK (outcome IN ('success','failure','approval_granted','approval_denied','self_corrected')),
  outcome_recorded_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_autonomy_history_agent ON agent_workforce_autonomy_history(agent_id, created_at DESC);

-- 5. Prompt Versions (prompt-version.service.ts — evolution tracking)
-- @statement
CREATE TABLE IF NOT EXISTS agent_workforce_prompt_versions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  change_type TEXT DEFAULT 'initial' CHECK (change_type IN ('initial','manual','evolution','rollback','cross_agent')),
  change_description TEXT,
  avg_truth_score REAL,
  task_count INTEGER DEFAULT 0,
  success_rate REAL,
  is_active INTEGER DEFAULT 1,
  rolled_back_at TEXT,
  rolled_back_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_active ON agent_workforce_prompt_versions(agent_id) WHERE is_active = 1;
-- @statement
CREATE INDEX IF NOT EXISTS idx_prompt_versions_agent ON agent_workforce_prompt_versions(agent_id, version DESC);

-- 6. Data Store (data-store.ts — agent-accessible collections)
-- @statement
CREATE TABLE IF NOT EXISTS agent_workforce_data_store (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  key TEXT,
  data TEXT DEFAULT '{}',
  recorded_at TEXT DEFAULT (datetime('now')),
  agent_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_data_store_collection ON agent_workforce_data_store(workspace_id, collection);
-- @statement
CREATE INDEX IF NOT EXISTS idx_data_store_key ON agent_workforce_data_store(workspace_id, collection, key);
-- @statement
CREATE INDEX IF NOT EXISTS idx_data_store_recorded ON agent_workforce_data_store(workspace_id, collection, recorded_at);
