-- 128-attribution-view.sql
-- Funnel Surgeon Phase 1: ground-truth attribution rollup.
--
-- Migration 121 added outreach_token + never_sync to contacts and the
-- funnel-shaped kind/payload/occurred_at columns to contact_events, and
-- plumbed contact_id + source_event_id onto revenue_entries. That gave
-- us everything needed to answer "which signal source produced this
-- dollar?" — except for a single place to ask the question.
--
-- This view joins the three pieces into one row per contact:
--   - source/bucket dimensions from the contact's custom_fields (how
--     the signal entered the funnel, e.g. author-ledger / market_signal)
--   - per-step timestamps (first_seen, qualified, reached, demo, trial,
--     paid) as the MIN occurred_at of each kind
--   - lifetime_revenue_cents as SUM of revenue_entries joined by
--     contact_id
--
-- Advisory-only: downstream experiments read this view to surface
-- conversion rates and drop-off steps. It is NOT a source of truth for
-- billing — revenue_entries itself owns that.
--
-- Views are not tables and do not appear in sqlite_master type='table',
-- so no migration-schema-probe registry row is needed for this file.

CREATE VIEW IF NOT EXISTS agent_workforce_attribution_rollup AS
SELECT
  c.id AS contact_id,
  c.workspace_id AS workspace_id,
  c.contact_type AS contact_type,
  c.status AS status,
  c.never_sync AS never_sync,
  json_extract(c.custom_fields, '$.x_source') AS source,
  json_extract(c.custom_fields, '$.x_bucket') AS bucket,
  json_extract(c.custom_fields, '$.x_intent') AS intent,
  (SELECT MIN(COALESCE(e.occurred_at, e.created_at))
     FROM agent_workforce_contact_events e
     WHERE e.contact_id = c.id) AS first_seen_ts,
  (SELECT MIN(COALESCE(e.occurred_at, e.created_at))
     FROM agent_workforce_contact_events e
     WHERE e.contact_id = c.id AND e.kind = 'x:qualified') AS qualified_ts,
  (SELECT MIN(COALESCE(e.occurred_at, e.created_at))
     FROM agent_workforce_contact_events e
     WHERE e.contact_id = c.id AND e.kind = 'x:reached') AS reached_ts,
  (SELECT MIN(COALESCE(e.occurred_at, e.created_at))
     FROM agent_workforce_contact_events e
     WHERE e.contact_id = c.id AND e.kind = 'demo:booked') AS demo_ts,
  (SELECT MIN(COALESCE(e.occurred_at, e.created_at))
     FROM agent_workforce_contact_events e
     WHERE e.contact_id = c.id AND e.kind = 'trial:started') AS trial_ts,
  (SELECT MIN(COALESCE(e.occurred_at, e.created_at))
     FROM agent_workforce_contact_events e
     WHERE e.contact_id = c.id AND e.kind = 'plan:paid') AS paid_ts,
  COALESCE(
    (SELECT SUM(r.amount_cents)
       FROM agent_workforce_revenue_entries r
       WHERE r.contact_id = c.id),
    0
  ) AS lifetime_revenue_cents
FROM agent_workforce_contacts c;
