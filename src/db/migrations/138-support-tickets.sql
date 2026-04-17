-- Support tickets
-- @statement
CREATE TABLE IF NOT EXISTS support_tickets (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  contact_id       TEXT REFERENCES agent_workforce_contacts(id),
  assignee_id      TEXT,
  ticket_number    INTEGER,
  subject          TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'open',
  priority         TEXT NOT NULL DEFAULT 'normal',
  category         TEXT,
  channel          TEXT DEFAULT 'manual',
  tags             TEXT DEFAULT '[]',
  first_response_at TEXT,
  resolved_at      TEXT,
  closed_at        TEXT,
  sla_breach       INTEGER NOT NULL DEFAULT 0,
  metadata         TEXT DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_tickets_workspace ON support_tickets(workspace_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_tickets_contact ON support_tickets(contact_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(workspace_id, status);
-- @statement
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON support_tickets(assignee_id);

-- Ticket comments and internal notes
-- @statement
CREATE TABLE IF NOT EXISTS ticket_comments (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  ticket_id        TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id        TEXT,
  author_name      TEXT,
  body             TEXT NOT NULL,
  is_internal      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket ON ticket_comments(ticket_id, created_at);

-- Website analytics snapshots (integration point)
-- @statement
CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  period_start     TEXT NOT NULL,
  period_end       TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'manual',
  pageviews        INTEGER,
  unique_visitors  INTEGER,
  sessions         INTEGER,
  avg_session_duration_secs REAL,
  bounce_rate      REAL,
  top_pages        TEXT DEFAULT '[]',
  top_referrers    TEXT DEFAULT '[]',
  metadata         TEXT DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_analytics_workspace_period ON analytics_snapshots(workspace_id, period_start DESC);
