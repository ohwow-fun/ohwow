-- Platform-generic posted-text dedup log.
-- Replaces the X-only x_posted_log (migration 129) with a multi-platform
-- table. The old table stays untouched for backward compat; both the X
-- and Threads posting handlers write to this new table going forward.
CREATE TABLE IF NOT EXISTS posted_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  text_preview TEXT NOT NULL,
  text_length INTEGER NOT NULL DEFAULT 0,
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  approval_id TEXT,
  task_id TEXT,
  source TEXT,
  UNIQUE (workspace_id, platform, text_hash)
);

CREATE INDEX IF NOT EXISTS idx_posted_log_workspace_platform_ts
  ON posted_log (workspace_id, platform, posted_at DESC);
