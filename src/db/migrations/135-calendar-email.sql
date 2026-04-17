-- Calendar accounts (integration config)
-- @statement
CREATE TABLE IF NOT EXISTS calendar_accounts (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  provider         TEXT NOT NULL DEFAULT 'local',
  label            TEXT NOT NULL,
  credentials      TEXT DEFAULT '{}',
  sync_cursor      TEXT,
  last_synced_at   TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_calendar_accounts_workspace ON calendar_accounts(workspace_id);

-- Calendar events
-- @statement
CREATE TABLE IF NOT EXISTS calendar_events (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  account_id       TEXT REFERENCES calendar_accounts(id) ON DELETE CASCADE,
  external_id      TEXT,
  title            TEXT NOT NULL,
  description      TEXT,
  location         TEXT,
  start_at         TEXT NOT NULL,
  end_at           TEXT NOT NULL,
  all_day          INTEGER NOT NULL DEFAULT 0,
  recurrence_rule  TEXT,
  attendees        TEXT DEFAULT '[]',
  organizer_email  TEXT,
  status           TEXT NOT NULL DEFAULT 'confirmed',
  reminders        TEXT DEFAULT '[]',
  metadata         TEXT DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_calendar_events_workspace_time ON calendar_events(workspace_id, start_at, end_at);
-- @statement
CREATE INDEX IF NOT EXISTS idx_calendar_events_account ON calendar_events(account_id);
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_events_external ON calendar_events(account_id, external_id);

-- Email accounts (integration config)
-- @statement
CREATE TABLE IF NOT EXISTS email_accounts (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  provider         TEXT NOT NULL DEFAULT 'local',
  email_address    TEXT NOT NULL,
  label            TEXT NOT NULL,
  credentials      TEXT DEFAULT '{}',
  sync_cursor      TEXT,
  last_synced_at   TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_email_accounts_workspace ON email_accounts(workspace_id);

-- Email messages
-- @statement
CREATE TABLE IF NOT EXISTS email_messages (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  account_id       TEXT REFERENCES email_accounts(id) ON DELETE CASCADE,
  external_id      TEXT,
  thread_id        TEXT,
  from_address     TEXT NOT NULL,
  from_name        TEXT,
  to_addresses     TEXT DEFAULT '[]',
  cc_addresses     TEXT DEFAULT '[]',
  bcc_addresses    TEXT DEFAULT '[]',
  subject          TEXT,
  body_text        TEXT,
  body_html        TEXT,
  snippet          TEXT,
  labels           TEXT DEFAULT '[]',
  is_read          INTEGER NOT NULL DEFAULT 0,
  is_starred       INTEGER NOT NULL DEFAULT 0,
  has_attachments  INTEGER NOT NULL DEFAULT 0,
  received_at      TEXT NOT NULL,
  metadata         TEXT DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_email_messages_workspace_date ON email_messages(workspace_id, received_at DESC);
-- @statement
CREATE INDEX IF NOT EXISTS idx_email_messages_account ON email_messages(account_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages(thread_id);
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_external ON email_messages(account_id, external_id);

-- Email drafts
-- @statement
CREATE TABLE IF NOT EXISTS email_drafts (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  account_id       TEXT REFERENCES email_accounts(id) ON DELETE CASCADE,
  reply_to_id      TEXT REFERENCES email_messages(id),
  to_addresses     TEXT DEFAULT '[]',
  cc_addresses     TEXT DEFAULT '[]',
  subject          TEXT,
  body_text        TEXT,
  body_html        TEXT,
  status           TEXT NOT NULL DEFAULT 'draft',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_email_drafts_workspace ON email_drafts(workspace_id);
