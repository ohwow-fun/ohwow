-- Ethos System: Ethical evaluation persistence (Aristotle + Kant + Noddings)
-- Multi-framework moral reasoning for autonomous agent decisions

CREATE TABLE IF NOT EXISTS ethical_evaluations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  action TEXT NOT NULL,
  permitted INTEGER NOT NULL,
  recommendation TEXT NOT NULL CHECK (recommendation IN ('proceed','proceed_with_caution','escalate','block')),
  reasoning TEXT NOT NULL,
  framework_results TEXT NOT NULL DEFAULT '[]',
  constraint_violations TEXT DEFAULT '[]',
  dilemma_detected INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ethical_evaluations_time ON ethical_evaluations(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ethical_evaluations_recommendation ON ethical_evaluations(workspace_id, recommendation);

CREATE TABLE IF NOT EXISTS moral_profile (
  id TEXT PRIMARY KEY DEFAULT 'default',
  workspace_id TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'rule_following',
  consistency_score REAL DEFAULT 0.5,
  dilemmas_resolved INTEGER DEFAULT 0,
  constraint_violations INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);
