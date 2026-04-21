-- Eternal Systems notification log.
--
-- Each row records a trustee notification emitted during a mode transition
-- (normal → conservative, conservative → estate). The delivered flag is
-- reserved for transport-layer confirmation; the default stub implementation
-- writes rows with delivered=0 and logs at WARN level.
CREATE TABLE IF NOT EXISTS eternal_notifications (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  mode       TEXT NOT NULL,
  reason     TEXT NOT NULL,
  delivered  INTEGER NOT NULL DEFAULT 0
);
