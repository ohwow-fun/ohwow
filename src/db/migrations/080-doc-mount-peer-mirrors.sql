-- ============================================================================
-- 080: Doc Mount Peer Mirrors
--
-- Tracks doc mounts available on peer devices for mesh-distributed
-- documentation access.
-- ============================================================================

CREATE TABLE IF NOT EXISTS doc_mount_peer_mirrors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mount_namespace TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  peer_mount_id TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  page_count INTEGER DEFAULT 0,
  crawled_at TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(mount_namespace, peer_id)
);

CREATE INDEX IF NOT EXISTS idx_doc_mount_peer_mirrors_namespace
  ON doc_mount_peer_mirrors(mount_namespace);
CREATE INDEX IF NOT EXISTS idx_doc_mount_peer_mirrors_peer
  ON doc_mount_peer_mirrors(peer_id);
