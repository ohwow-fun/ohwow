-- Migration 003: Orchestrator A2A support
-- Adds tables for A2A connections, task logs, projects, and schedules

-- A2A connections to external agents
CREATE TABLE IF NOT EXISTS a2a_connections (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  agent_card_url TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'none',
  auth_config TEXT NOT NULL DEFAULT '{}',
  trust_level TEXT NOT NULL DEFAULT 'read_only',
  store_results INTEGER NOT NULL DEFAULT 1,
  result_retention_hours INTEGER NOT NULL DEFAULT 168,
  allowed_data_types TEXT NOT NULL DEFAULT '[]',
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 60,
  rate_limit_per_hour INTEGER NOT NULL DEFAULT 1000,
  status TEXT NOT NULL DEFAULT 'pending',
  last_health_check_at TEXT,
  last_health_status TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  agent_card_cache TEXT,
  agent_card_fetched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A2A task audit logs
CREATE TABLE IF NOT EXISTS a2a_task_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  a2a_task_id TEXT NOT NULL,
  method TEXT NOT NULL,
  api_key_id TEXT,
  connection_id TEXT,
  agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  request_summary TEXT,
  result_summary TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_cents REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Local project management
CREATE TABLE IF NOT EXISTS agent_workforce_projects (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  color TEXT DEFAULT '#6366f1',
  due_date TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Local cron schedules
CREATE TABLE IF NOT EXISTS agent_workforce_schedules (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  agent_id TEXT,
  workflow_id TEXT,
  label TEXT,
  cron TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  task_prompt TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Local workflows table
CREATE TABLE IF NOT EXISTS agent_workforce_workflows (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  steps TEXT NOT NULL DEFAULT '[]',
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Add project_id and board_column to tasks
-- These use the @statement marker so the migration runner executes them individually
-- and swallows "duplicate column" errors for idempotency.
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN project_id TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN board_column TEXT DEFAULT 'backlog';
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN due_date TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN labels TEXT DEFAULT '[]';
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN parent_task_id TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN position INTEGER DEFAULT 0;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN archived_at TEXT;
