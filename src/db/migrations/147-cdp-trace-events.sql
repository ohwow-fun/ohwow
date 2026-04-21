-- CDP trace events table — persists all cdp:true structured log entries
-- so browser lifecycle, claim/release, and tab events can be queried
-- via the HTTP API and MCP tool without log parsing.
CREATE TABLE IF NOT EXISTS cdp_trace_events (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  ts            TEXT NOT NULL,
  action        TEXT NOT NULL,
  profile       TEXT,
  target_id     TEXT,
  owner         TEXT,
  url           TEXT,
  metadata_json TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cdp_trace_events_workspace_ts
  ON cdp_trace_events (workspace_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_cdp_trace_events_workspace_action
  ON cdp_trace_events (workspace_id, action, ts DESC);
