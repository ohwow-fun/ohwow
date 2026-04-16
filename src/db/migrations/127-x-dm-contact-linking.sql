-- 127-x-dm-contact-linking.sql — wire DM threads + signals to CRM contacts.
--
-- Goal: let the DM poller stamp a contact_id on a thread when the
-- correspondent matches an existing row in agent_workforce_contacts.
-- No auto-create; the poller emits an `unknown_correspondent` signal
-- (reserved by migration 126) when an inbound arrives with no match,
-- and the operator creates the contact via ohwow_create_contact.
--
-- Key design choice: counterparty IS numeric X user ID, not handle.
-- Live DOM probe (scripts/probe-x-dm-dom.mjs, 2026-04-16) confirmed
-- X's DM thread header shows ONLY the display name in 2026 — the
-- @handle is not reachable from the static DOM. The conversation_pair
-- already carries both user IDs as `<id1>:<id2>`, so the correspondent's
-- id is recoverable by simple string-split once the daemon knows the
-- operator's own X user id (stored in runtime_config_overrides at key
-- `x.self_user_id`). Contacts opt in by setting
-- `custom_fields.x_user_id` on the row they want the poller to stamp.
--
-- Handles can be renamed; numeric user IDs are stable for account
-- lifetime. Keying on id is also faster (no DOM extraction per thread).
--
-- Rollback is a no-op: both columns are nullable. If we revert the
-- linking logic the columns just stay empty.

-- @statement
ALTER TABLE x_dm_threads ADD COLUMN counterparty_user_id TEXT;

-- @statement
ALTER TABLE x_dm_threads ADD COLUMN contact_id TEXT;

-- @statement
ALTER TABLE x_dm_signals ADD COLUMN contact_id TEXT;

-- @statement
CREATE INDEX IF NOT EXISTS idx_x_dm_threads_contact
  ON x_dm_threads(workspace_id, contact_id);
