-- Outbound queue for buffering control-plane reports when offline
CREATE TABLE IF NOT EXISTS outbound_queue (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT
);
