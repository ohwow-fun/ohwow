-- Migration 005: Telegram integration via Bot API long-polling
-- Adds tables for Telegram connections and message history

-- Telegram bot connections
CREATE TABLE IF NOT EXISTS telegram_connections (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  bot_token TEXT NOT NULL,
  bot_username TEXT,
  bot_id TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id)
);

-- Chat message history (for orchestrator context)
CREATE TABLE IF NOT EXISTS telegram_chat_messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  chat_id TEXT NOT NULL,
  sender TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tg_messages_chat ON telegram_chat_messages(chat_id, created_at DESC);
