-- Eternal Systems state table.
--
-- Single-row singleton (id=1 enforced by CHECK constraint). Tracks the
-- current eternal mode (normal / conservative / estate), the last time
-- the operator was active, and the reason for the last mode transition.
--
-- The INSERT OR IGNORE ensures this migration is idempotent: re-running
-- it (e.g. in a reset flow) won't overwrite an existing row.
CREATE TABLE IF NOT EXISTS eternal_state (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  mode                 TEXT NOT NULL DEFAULT 'normal',
  last_activity_at     TEXT,
  mode_changed_at      TEXT,
  mode_changed_reason  TEXT
);

INSERT OR IGNORE INTO eternal_state (id, mode) VALUES (1, 'normal');
