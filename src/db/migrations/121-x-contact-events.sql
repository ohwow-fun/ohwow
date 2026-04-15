-- 121-x-contact-events.sql
-- Layer-4 sales loop: substrate for attributing X signal → contact → revenue.
--
-- The contact_events table was introduced in 001 with columns tuned for
-- free-text CRM notes (event_type, title, description, agent_id, task_id,
-- metadata, created_at). The sales-loop flow needs a structured-event
-- shape (kind, source, payload JSON, occurred_at) that can encode the
-- funnel: x:seen, x:reached, x:replied, x:qualified, dm:received,
-- demo:booked, plan:paid. Rather than rename or migrate data, we grow
-- the new columns alongside the legacy ones so both consumer styles
-- coexist. Legacy CRM tools keep writing event_type/metadata; the
-- sales-loop path writes kind/payload/occurred_at.
--
-- All statements are idempotent. init.ts splits on `-- @statement` and
-- swallows "duplicate column" errors so re-runs against a partially
-- applied DB are safe.
--
-- Adds:
--   - outreach_token + never_sync on contacts (privacy + attribution).
--   - kind/source/payload/occurred_at on contact_events (funnel shape).
--   - contact_id + source_event_id on revenue_entries (attribution join).

ALTER TABLE agent_workforce_contacts ADD COLUMN outreach_token TEXT;
-- @statement
ALTER TABLE agent_workforce_contacts ADD COLUMN never_sync INTEGER NOT NULL DEFAULT 0;
-- @statement
ALTER TABLE agent_workforce_contact_events ADD COLUMN kind TEXT;
-- @statement
ALTER TABLE agent_workforce_contact_events ADD COLUMN source TEXT;
-- @statement
ALTER TABLE agent_workforce_contact_events ADD COLUMN payload TEXT DEFAULT '{}';
-- @statement
ALTER TABLE agent_workforce_contact_events ADD COLUMN occurred_at TEXT;
-- @statement
CREATE INDEX IF NOT EXISTS idx_contact_events_workspace_kind
  ON agent_workforce_contact_events(workspace_id, kind, occurred_at);
-- @statement
ALTER TABLE agent_workforce_revenue_entries ADD COLUMN contact_id TEXT REFERENCES agent_workforce_contacts(id);
-- @statement
ALTER TABLE agent_workforce_revenue_entries ADD COLUMN source_event_id TEXT REFERENCES agent_workforce_contact_events(id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_revenue_contact ON agent_workforce_revenue_entries(contact_id);
