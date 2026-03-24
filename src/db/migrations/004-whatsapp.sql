-- Migration 004: WhatsApp integration via Baileys
-- Adds tables for WhatsApp connections, allowlisted chats, and message history

-- WhatsApp connections (one per runtime)
CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  phone_number TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  auth_state TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Allowlisted chats
CREATE TABLE IF NOT EXISTS whatsapp_allowed_chats (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  connection_id TEXT NOT NULL REFERENCES whatsapp_connections(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  chat_name TEXT,
  chat_type TEXT DEFAULT 'individual',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(connection_id, chat_id)
);

-- Chat message history (for orchestrator context)
CREATE TABLE IF NOT EXISTS whatsapp_chat_messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  connection_id TEXT NOT NULL REFERENCES whatsapp_connections(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  sender TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_chat ON whatsapp_chat_messages(connection_id, chat_id, created_at DESC);
