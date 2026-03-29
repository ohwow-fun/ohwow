-- 009-nudges.sql
-- Proactive nudges for the autonomous runtime

CREATE TABLE IF NOT EXISTS agent_workforce_nudges (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  nudge_type TEXT NOT NULL CHECK (nudge_type IN ('overdue_task', 'aging_approval', 'idle_agent', 'stale_contact', 'plan_blocked', 'streak_risk')),
  title TEXT NOT NULL,
  description TEXT,
  suggested_action TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dismissed', 'acted')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nudges_workspace_status ON agent_workforce_nudges(workspace_id, status);
