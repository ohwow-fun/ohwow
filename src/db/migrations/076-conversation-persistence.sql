-- Conversation persistence: store every message permanently (local SQLite)
-- Replaces the JSON blob approach in orchestrator_chat_sessions

CREATE TABLE IF NOT EXISTS orchestrator_conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT,
  source TEXT NOT NULL DEFAULT 'ohwow',
  source_conversation_id TEXT,
  channel TEXT,                          -- 'tui' | 'whatsapp' | 'telegram' | 'voice'
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
  message_count INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  last_extracted_at TEXT,
  extraction_count INTEGER NOT NULL DEFAULT 0,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conv_workspace
  ON orchestrator_conversations(workspace_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_conv_source
  ON orchestrator_conversations(workspace_id, source);

CREATE TABLE IF NOT EXISTS orchestrator_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES orchestrator_conversations(id),
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  token_count INTEGER,
  metadata TEXT DEFAULT '{}',
  source_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_msg_conversation
  ON orchestrator_messages(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_msg_workspace
  ON orchestrator_messages(workspace_id, created_at DESC);

-- FTS5 standalone table (not content-sync, since orchestrator_messages uses TEXT PK)
-- Manually populated via application-level inserts after message creation
CREATE VIRTUAL TABLE IF NOT EXISTS orchestrator_messages_fts USING fts5(
  message_id,
  content
);

-- Provenance: link memories back to conversations
ALTER TABLE agent_workforce_agent_memory
  ADD COLUMN source_conversation_id TEXT REFERENCES orchestrator_conversations(id);

ALTER TABLE agent_workforce_agent_memory
  ADD COLUMN source_message_index INTEGER;
