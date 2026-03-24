-- Migration 044: Multi-connection fixes
-- 1. Drop UNIQUE(workspace_id) on telegram_connections (SQLite requires table recreation)
-- 2. Add connection_locks table for preventing two devices from connecting the same WA number

-- Recreate telegram_connections without the implicit UNIQUE constraint on workspace_id
CREATE TABLE telegram_connections_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  bot_token TEXT NOT NULL,
  bot_username TEXT,
  bot_id TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  label TEXT,
  device_id TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO telegram_connections_new SELECT
  id, workspace_id, bot_token, bot_username, bot_id, status,
  label, device_id, is_default, created_at, updated_at
FROM telegram_connections;
DROP TABLE telegram_connections;
ALTER TABLE telegram_connections_new RENAME TO telegram_connections;

-- Connection locks: prevent two devices from connecting the same WhatsApp number
CREATE TABLE IF NOT EXISTS connection_locks (
  connection_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);
