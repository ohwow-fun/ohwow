-- 014: Webhooks and Local Triggers
-- Stores incoming webhook events and trigger-to-action mappings for event-driven automation.

-- Audit log of all incoming webhook payloads
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source TEXT NOT NULL DEFAULT 'ghl',
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  headers TEXT NOT NULL DEFAULT '{}',
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_source ON webhook_events(source, event_type);
CREATE INDEX IF NOT EXISTS idx_webhook_events_created ON webhook_events(created_at);

-- Event-to-action mappings
CREATE TABLE IF NOT EXISTS local_triggers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'ghl',
  event_type TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '{}',
  action_type TEXT NOT NULL DEFAULT 'run_agent',
  action_config TEXT NOT NULL DEFAULT '{}',
  cooldown_seconds INTEGER NOT NULL DEFAULT 60,
  last_fired_at TEXT,
  fire_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_local_triggers_source ON local_triggers(source, event_type);

-- Execution audit log per trigger firing
CREATE TABLE IF NOT EXISTS local_trigger_executions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trigger_id TEXT NOT NULL REFERENCES local_triggers(id) ON DELETE CASCADE,
  source_event TEXT NOT NULL,
  source_metadata TEXT NOT NULL DEFAULT '{}',
  action_type TEXT NOT NULL,
  action_result TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trigger_executions_trigger ON local_trigger_executions(trigger_id);
CREATE INDEX IF NOT EXISTS idx_trigger_executions_created ON local_trigger_executions(created_at);
