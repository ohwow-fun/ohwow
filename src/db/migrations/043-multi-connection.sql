-- Migration 043: Multi-connection support for WhatsApp and Telegram
-- Allows multiple WhatsApp numbers and Telegram bots per workspace.

-- WhatsApp: add label, device_id, is_default columns
ALTER TABLE whatsapp_connections ADD COLUMN label TEXT;
ALTER TABLE whatsapp_connections ADD COLUMN device_id TEXT;
ALTER TABLE whatsapp_connections ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

-- Telegram: add connection_id to message history for multi-bot support
ALTER TABLE telegram_chat_messages ADD COLUMN connection_id TEXT REFERENCES telegram_connections(id) ON DELETE SET NULL;

-- Telegram: add label, device_id, is_default columns
ALTER TABLE telegram_connections ADD COLUMN label TEXT;
ALTER TABLE telegram_connections ADD COLUMN device_id TEXT;
ALTER TABLE telegram_connections ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

-- Index for looking up messages by connection
CREATE INDEX IF NOT EXISTS idx_tg_messages_connection ON telegram_chat_messages(connection_id, chat_id, created_at DESC);
