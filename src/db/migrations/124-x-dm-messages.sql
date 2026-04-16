-- 124-x-dm-messages.sql — store the result of XDmPollerScheduler ticks.
--
-- The poller calls listDmsViaBrowser hourly and writes the inbox
-- summaries here. Two tables: a current-state thread row (one per
-- conversation_pair) and an append-only observation log keyed by the
-- preview text's hash so we don't re-insert when nothing changed.
--
-- Why two tables: thread row supports "show me my inbox" queries
-- without scanning history; observations supports "what changed when"
-- queries used by future findings/triage. Both are write-light — DMs
-- are low-volume.
--
-- Dedup key on observations is (workspace_id, conversation_pair,
-- preview_hash). The poller computes preview_hash = sha1 of the
-- preview text, so identical previews observed across ticks collapse
-- to one row. New text from the same correspondent inserts a new
-- observation and bumps the thread's last_seen_at + last_preview.
--
-- No FK to agent_workforce_contacts: contact linking layers on later
-- (the operator must approve the link via the approval-queue path).
-- Storing handle / pair without a FK keeps the ingest tick cheap and
-- doesn't gate it on CRM state.

CREATE TABLE IF NOT EXISTS x_dm_threads (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  conversation_pair TEXT NOT NULL,
  primary_name TEXT,
  last_preview TEXT,
  last_preview_hash TEXT,
  has_unread INTEGER NOT NULL DEFAULT 0,
  observation_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  raw_meta TEXT,
  UNIQUE(workspace_id, conversation_pair)
);

CREATE INDEX IF NOT EXISTS idx_x_dm_threads_workspace
  ON x_dm_threads(workspace_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS x_dm_observations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  conversation_pair TEXT NOT NULL,
  primary_name TEXT,
  preview_text TEXT NOT NULL,
  preview_hash TEXT NOT NULL,
  has_unread INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, conversation_pair, preview_hash)
);

CREATE INDEX IF NOT EXISTS idx_x_dm_obs_pair
  ON x_dm_observations(workspace_id, conversation_pair, observed_at DESC);
