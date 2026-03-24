-- 008-plans.sql
-- Autonomous Goal Planner tables

CREATE TABLE IF NOT EXISTS agent_workforce_plans (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'executing', 'completed', 'failed', 'rejected')),
  constraints TEXT DEFAULT '{}',
  total_steps INTEGER NOT NULL DEFAULT 0,
  completed_steps INTEGER NOT NULL DEFAULT 0,
  failed_steps INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plans_workspace ON agent_workforce_plans(workspace_id);
CREATE INDEX IF NOT EXISTS idx_plans_status ON agent_workforce_plans(status);

CREATE TABLE IF NOT EXISTS agent_workforce_plan_steps (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  plan_id TEXT NOT NULL REFERENCES agent_workforce_plans(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  agent_id TEXT,
  depends_on TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'skipped')),
  task_id TEXT,
  output_summary TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON agent_workforce_plan_steps(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_steps_status ON agent_workforce_plan_steps(status);
