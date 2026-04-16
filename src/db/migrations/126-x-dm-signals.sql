-- 126-x-dm-signals.sql — per-message "worth a second look" signals.
--
-- XDmPollerScheduler writes to this table whenever a newly-ingested
-- inbound DM matches a trigger phrase. Goal: surface conversations
-- the operator should read without polluting self_findings (which is
-- experiment-owned and novelty-scored, unsuitable for high-volume
-- ingest bread crumbs).
--
-- Design choices documented here because they're load-bearing:
--
-- 1. Per-message dedup (UNIQUE workspace_id, message_id, signal_type).
--    One signal per (msg, type). Re-reading a thread on every tick
--    must not duplicate rows — the message UUID from X's DOM is the
--    stable dedup handle established in migration 125.
--
-- 2. signal_type enum. Today only `trigger_phrase` is written. Future
--    types (`unknown_correspondent`, `contact_link_candidate`) are
--    reserved so the reader side doesn't need to widen its filter
--    when new signal kinds land.
--
-- 3. No FK to x_dm_messages. The message row may not exist yet at the
--    instant we insert the signal (we're inside the same tick), and
--    adding a FK would force us to split the insert into two steps.
--    The UNIQUE constraint on message_id is the reliability guarantee
--    we actually need.
--
-- 4. primary_name + text denormalized. Reader UIs want "who sent
--    this, what did it say" without a 3-table join; cheap to carry
--    the 100-byte snapshot alongside the reference.

CREATE TABLE IF NOT EXISTS x_dm_signals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  conversation_pair TEXT NOT NULL,
  message_id TEXT NOT NULL,
  signal_type TEXT NOT NULL CHECK (signal_type IN (
    'trigger_phrase',
    'unknown_correspondent',
    'contact_link_candidate'
  )),
  trigger_phrase TEXT,
  primary_name TEXT,
  text TEXT,
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, message_id, signal_type)
);

CREATE INDEX IF NOT EXISTS idx_x_dm_signals_workspace_observed
  ON x_dm_signals(workspace_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_x_dm_signals_pair
  ON x_dm_signals(workspace_id, conversation_pair, observed_at DESC);
