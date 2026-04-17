-- 135-x-post-drafts.sql
-- Staged X post drafts sourced from market-radar findings.
--
-- The market-radar pipeline (scrape-diff probes → findings → hourly
-- distiller) lands one row per finding-worth-posting. Drafts are
-- LLM-authored from the finding evidence, then wait for operator
-- approval before anything goes out. Approval flips status from
-- 'pending' to 'approved'; the existing posting path picks approved
-- rows up and writes to posted_log/x_posted_log on success.
--
-- source_finding_id is the `self_findings.id` that seeded this draft.
-- UNIQUE on (workspace_id, source_finding_id) makes the distiller
-- idempotent — re-running it against the same finding is a no-op.
--
-- status: 'pending' → 'approved' → (external posting) or
--         'pending' → 'rejected'. The posting handler is free to
-- track additional states in posted_log once a post fires.

CREATE TABLE IF NOT EXISTS x_post_drafts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  body TEXT NOT NULL,
  source_finding_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  rejected_at TEXT,
  UNIQUE (workspace_id, source_finding_id)
);

CREATE INDEX IF NOT EXISTS idx_x_post_drafts_workspace_status
  ON x_post_drafts (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_x_post_drafts_source_finding
  ON x_post_drafts (source_finding_id)
  WHERE source_finding_id IS NOT NULL;
