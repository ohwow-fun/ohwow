-- 032-nudge-type-update.sql
-- Expand nudge_type CHECK constraint to include agent_suggestion, task_failed, needs_approval
-- SQLite can't ALTER CHECK, so we recreate the table.

CREATE TABLE IF NOT EXISTS agent_workforce_nudges_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  nudge_type TEXT NOT NULL CHECK (nudge_type IN (
    'overdue_task', 'aging_approval', 'idle_agent', 'stale_contact',
    'plan_blocked', 'streak_risk', 'agent_suggestion', 'task_failed', 'needs_approval'
  )),
  title TEXT NOT NULL,
  description TEXT,
  suggested_action TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dismissed', 'acted')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO agent_workforce_nudges_new
  SELECT * FROM agent_workforce_nudges;

DROP TABLE IF EXISTS agent_workforce_nudges;

ALTER TABLE agent_workforce_nudges_new RENAME TO agent_workforce_nudges;

CREATE INDEX IF NOT EXISTS idx_nudges_workspace_status ON agent_workforce_nudges(workspace_id, status);
