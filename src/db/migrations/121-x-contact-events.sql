-- 121-x-contact-events.sql
-- Layer-4 sales loop: substrate for attributing X signal → contact → revenue.
--
-- Adds:
--   - agent_workforce_contact_events: append-only log of every touchpoint
--     (x:seen, x:reached, x:replied, dm:received, demo:booked, plan:paid).
--   - outreach_token on contacts: opaque token we embed in outbound links so
--     ohwow.fun can attribute a paid signup back to a local contact without
--     a live cross-repo call.
--   - never_sync on contacts: control-plane skips rows flagged by X-sourced
--     ingestion so PII harvested from public profiles stays workspace-local.
--   - contact_id + source_event_id on revenue entries: the join that makes
--     "X post → demo → paid plan" expressible in one query.
--
-- All additive; no data rewrites. schema_migrations tracks filename so
-- plain ALTER ADD COLUMN runs exactly once.

ALTER TABLE agent_workforce_contacts ADD COLUMN outreach_token TEXT;
ALTER TABLE agent_workforce_contacts ADD COLUMN never_sync INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS agent_workforce_contact_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT,
  payload TEXT DEFAULT '{}',
  occurred_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (contact_id) REFERENCES agent_workforce_contacts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_events_contact
  ON agent_workforce_contact_events(contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_events_workspace_kind
  ON agent_workforce_contact_events(workspace_id, kind, occurred_at DESC);

ALTER TABLE agent_workforce_revenue_entries ADD COLUMN contact_id TEXT
  REFERENCES agent_workforce_contacts(id);
ALTER TABLE agent_workforce_revenue_entries ADD COLUMN source_event_id TEXT
  REFERENCES agent_workforce_contact_events(id);

CREATE INDEX IF NOT EXISTS idx_revenue_contact
  ON agent_workforce_revenue_entries(contact_id);
