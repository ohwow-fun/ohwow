-- Workspace-to-workspace peering
-- Allows two ohwow daemons to connect directly using the full workspace API

CREATE TABLE IF NOT EXISTS workspace_peers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  tunnel_url TEXT,
  peer_token TEXT,
  our_token TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'rejected', 'error')),
  capabilities TEXT NOT NULL DEFAULT '{}',
  last_seen_at TEXT,
  last_health_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
