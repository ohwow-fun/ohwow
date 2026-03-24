-- Workflow triggers: event-based automation that auto-runs workflows
CREATE TABLE IF NOT EXISTS agent_workforce_workflow_triggers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_event TEXT NOT NULL CHECK (trigger_event IN (
    'task_completed', 'task_failed', 'task_needs_approval',
    'task_approved', 'task_rejected', 'human_task_completed',
    'task_handoff', 'email_received', 'contact_created'
  )),
  conditions TEXT,  -- JSON conditions for conditional firing
  cooldown_seconds INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  fire_count INTEGER DEFAULT 0,
  last_fired_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_triggers_workspace
  ON agent_workforce_workflow_triggers(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workflow_triggers_event
  ON agent_workforce_workflow_triggers(trigger_event, enabled);
