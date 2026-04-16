-- 129-x-posted-log.sql
-- Preventive duplicate-content gate for the X posting path.
--
-- The fix in composeTweetViaBrowser catches X's "Whoops! You already
-- said that." banner AFTER the post button is clicked. That stops
-- the infinite retry, but a retry still burns a CDP lane slot +
-- opens the compose modal + types the whole text before X refuses.
-- We'd rather never queue (or dispatch) the same bytes twice.
--
-- This table is the durable "we posted this" log. Every successful
-- publish writes a row here; the pre-flight gate in the postTweet
-- handler hashes the pending text and refuses immediately when a
-- recent row exists. Draft-selection (approved-draft-queue) also
-- consults it to skip re-approved duplicates at pick time.
--
-- text_hash is SHA-256 over the normalized (lowercased, whitespace-
-- collapsed) text. Unique per workspace+hash so re-attempts are a
-- no-op at the storage layer too.

CREATE TABLE IF NOT EXISTS x_posted_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  text_preview TEXT NOT NULL,
  text_length INTEGER NOT NULL DEFAULT 0,
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  approval_id TEXT,
  task_id TEXT,
  source TEXT,
  UNIQUE (workspace_id, text_hash)
);

CREATE INDEX IF NOT EXISTS idx_x_posted_log_workspace_ts
  ON x_posted_log (workspace_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_x_posted_log_hash
  ON x_posted_log (text_hash);
