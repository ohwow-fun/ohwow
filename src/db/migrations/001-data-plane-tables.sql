-- Local Runtime: Data Plane Tables
-- These are the tables whose data stays local on the customer's machine.
-- Schema mirrors the Supabase tables but runs on SQLite.

-- ============================================================================
-- TASKS
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_workforce_tasks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  input TEXT, -- JSON
  output TEXT, -- JSON
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'needs_approval', 'approved', 'rejected')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  model_used TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  scheduled_for TEXT,
  started_at TEXT,
  completed_at TEXT,
  duration_seconds INTEGER,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  approved_at TEXT,
  rejection_reason TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  contact_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON agent_workforce_tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON agent_workforce_tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON agent_workforce_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON agent_workforce_tasks(created_at);

-- ============================================================================
-- TASK MESSAGES
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_workforce_task_messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id TEXT NOT NULL REFERENCES agent_workforce_tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}', -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_messages_task ON agent_workforce_task_messages(task_id);

-- ============================================================================
-- AGENT MEMORY
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_workforce_agent_memory (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  memory_type TEXT NOT NULL CHECK (memory_type IN ('fact', 'skill', 'feedback_positive', 'feedback_negative', 'cross_agent')),
  content TEXT NOT NULL,
  source_task_id TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('extraction', 'approval', 'rejection', 'manual', 'cross_agent')),
  relevance_score REAL NOT NULL DEFAULT 0.5,
  times_used INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  token_count INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  superseded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_agent ON agent_workforce_agent_memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_workspace ON agent_workforce_agent_memory(workspace_id);
CREATE INDEX IF NOT EXISTS idx_memory_active ON agent_workforce_agent_memory(is_active);

-- ============================================================================
-- MEMORY EXTRACTION LOG
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_workforce_memory_extraction_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('task_completed', 'task_approved', 'task_rejected')),
  memories_extracted INTEGER NOT NULL DEFAULT 0,
  extraction_tokens_used INTEGER NOT NULL DEFAULT 0,
  extraction_cost_cents INTEGER NOT NULL DEFAULT 0,
  raw_extraction TEXT, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- BROWSER SESSIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_workforce_browser_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  provider_session_id TEXT NOT NULL DEFAULT '',
  cdp_url TEXT,
  live_view_url TEXT,
  status TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'active', 'idle', 'error', 'closed')),
  current_url TEXT,
  page_title TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_browser_sessions_task ON agent_workforce_browser_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_status ON agent_workforce_browser_sessions(status);

-- ============================================================================
-- TELEGRAM CHAT MESSAGES
-- ============================================================================

CREATE TABLE IF NOT EXISTS telegram_chat_messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  telegram_message_id INTEGER,
  sender TEXT NOT NULL CHECK (sender IN ('user', 'bot')),
  content TEXT NOT NULL,
  agent_id TEXT,
  task_id TEXT,
  metadata TEXT DEFAULT '{}', -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_telegram_messages_workspace ON telegram_chat_messages(workspace_id);
CREATE INDEX IF NOT EXISTS idx_telegram_messages_chat ON telegram_chat_messages(chat_id);

-- ============================================================================
-- ORCHESTRATOR CHAT SESSIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS orchestrator_chat_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  title TEXT,
  messages TEXT NOT NULL DEFAULT '[]', -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orchestrator_sessions_workspace ON orchestrator_chat_sessions(workspace_id);

-- ============================================================================
-- CONTACT EVENTS (data plane portion)
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_workforce_contact_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  agent_id TEXT,
  task_id TEXT,
  metadata TEXT DEFAULT '{}', -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contact_events_contact ON agent_workforce_contact_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_events_workspace ON agent_workforce_contact_events(workspace_id);

-- ============================================================================
-- BRIEFINGS
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_workforce_briefings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  briefing_type TEXT NOT NULL DEFAULT 'daily',
  briefing_date TEXT NOT NULL,
  content TEXT NOT NULL, -- JSON
  is_read INTEGER NOT NULL DEFAULT 0,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_briefings_workspace ON agent_workforce_briefings(workspace_id);
CREATE INDEX IF NOT EXISTS idx_briefings_date ON agent_workforce_briefings(briefing_date);

-- ============================================================================
-- LOCAL AGENT CONFIG CACHE
-- Synced from control plane, stored locally for offline operation
-- ============================================================================

CREATE TABLE IF NOT EXISTS local_agent_configs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT,
  system_prompt TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}', -- JSON (AgentConfig)
  status TEXT NOT NULL DEFAULT 'idle',
  stats TEXT NOT NULL DEFAULT '{}', -- JSON (AgentStats)
  department_id TEXT,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- LOCAL SCHEDULE CACHE
-- ============================================================================

CREATE TABLE IF NOT EXISTS local_schedule_configs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT,
  workflow_id TEXT,
  label TEXT,
  cron TEXT NOT NULL,
  task_prompt TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- LOCAL WORKFLOW CACHE
-- ============================================================================

CREATE TABLE IF NOT EXISTS local_workflow_configs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  steps TEXT NOT NULL DEFAULT '[]', -- JSON
  status TEXT NOT NULL DEFAULT 'active',
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
