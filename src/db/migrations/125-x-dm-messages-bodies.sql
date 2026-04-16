-- 125-x-dm-messages-bodies.sql — add per-message storage to the DM ingest.
--
-- Migration 124 introduced thread + observation tables that captured
-- only inbox-level previews (one row per (pair, preview_hash)). That
-- left the actual message bodies invisible — we stored the gloss the
-- inbox shows, not the conversation. Live DOM probe (2026-04-16,
-- scripts/probe-x-dm-dom.mjs) confirmed each message has a stable
-- per-conversation UUID exposed via `data-testid="message-<uuid>"`,
-- which is the right dedup key for body-level ingest.
--
-- Direction comes from the bubble's bg-primary (outbound) vs
-- bg-gray-50 (inbound) class — X never exposes a sender id in the DM
-- DOM, so this is the most reliable signal short of authenticated API
-- access.
--
-- Note that we still don't store an absolute timestamp: X inlines the
-- "x minutes ago" / "6:49 AM" tooltip into the message text and never
-- exposes a machine-readable datetime here. observed_at (when the
-- poller saw it) is the closest available stamp.

CREATE TABLE IF NOT EXISTS x_dm_messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  conversation_pair TEXT NOT NULL,
  message_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound', 'unknown')),
  text TEXT,
  is_media INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_x_dm_messages_pair
  ON x_dm_messages(workspace_id, conversation_pair, observed_at DESC);

-- Bring the threads table forward with one denormalized field so the
-- inbox query doesn't need a join to show the latest message body.
ALTER TABLE x_dm_threads ADD COLUMN last_message_id TEXT;
ALTER TABLE x_dm_threads ADD COLUMN last_message_text TEXT;
ALTER TABLE x_dm_threads ADD COLUMN last_message_direction TEXT;
