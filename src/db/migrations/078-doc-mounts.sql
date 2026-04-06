-- ============================================================================
-- 078: Doc Mounts
--
-- Virtual filesystem mounts for documentation sites.
-- Agents can mount a doc site and browse/search it via filesystem tools.
-- ============================================================================

CREATE TABLE IF NOT EXISTS doc_mounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  namespace TEXT NOT NULL,
  mount_path TEXT NOT NULL,
  page_count INTEGER DEFAULT 0,
  total_size_bytes INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  crawl_error TEXT,
  ttl_days INTEGER DEFAULT 7,
  crawled_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, namespace)
);

CREATE TABLE IF NOT EXISTS doc_mount_pages (
  id TEXT PRIMARY KEY,
  mount_id TEXT NOT NULL REFERENCES doc_mounts(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT,
  token_count INTEGER DEFAULT 0,
  byte_size INTEGER DEFAULT 0,
  crawled_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(mount_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_doc_mounts_workspace ON doc_mounts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_doc_mounts_status ON doc_mounts(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_doc_mount_pages_mount ON doc_mount_pages(mount_id);
