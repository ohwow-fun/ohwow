-- 142-x-reply-drafts.sql
-- Staged X/Threads reply drafts sourced from the pain-finder pipeline.
--
-- The reply schedulers (x-reply-scheduler, threads-reply-scheduler) used
-- to draft + auto-publish inline. The user's original complaint was that
-- replies kept landing on AI sellers because the scorer hardcoded a
-- generic topic-keyword list. The new pipeline (pain-oriented queries
-- + LLM pain-vs-seller classifier + two-mode drafter) writes to this
-- table instead. A new x-reply-dispatcher consumes approved rows and
-- posts them via the existing compose_reply executors.
--
-- One table serves both X and Threads — the `platform` column picks.
-- UNIQUE (workspace_id, reply_to_url) makes the scheduler idempotent:
-- re-running it against the same target post is a no-op.
--
-- mode drives the reply-voice prompt used when the draft was generated.
-- It's stored so the dispatcher / UI knows whether this was a direct
-- (1:1) reply or a viral-piggyback (broadcast) reply.
--
-- verdict_json captures the classifier output for audit (class,
-- pain_domain, severity, specificity, sellerish, rationale). Score is
-- the selector's numeric score at time of drafting.
--
-- status transitions:
--   pending → approved → applied   (operator approves, dispatcher posts)
--   pending → rejected              (operator rejects)
--   pending → auto_applied          (approval-gate disabled; posts as soon
--                                    as dispatcher picks it up)

CREATE TABLE IF NOT EXISTS x_reply_drafts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  platform TEXT NOT NULL
    CHECK (platform IN ('x', 'threads')),
  reply_to_url TEXT NOT NULL,
  reply_to_author TEXT,
  reply_to_text TEXT,
  reply_to_likes INTEGER,
  reply_to_replies INTEGER,
  mode TEXT NOT NULL
    CHECK (mode IN ('direct', 'viral')),
  body TEXT NOT NULL,
  alternates_json TEXT,
  verdict_json TEXT,
  score REAL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'applied', 'auto_applied')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  rejected_at TEXT,
  applied_at TEXT,
  UNIQUE (workspace_id, reply_to_url)
);

CREATE INDEX IF NOT EXISTS idx_x_reply_drafts_workspace_status
  ON x_reply_drafts (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_x_reply_drafts_platform_status
  ON x_reply_drafts (workspace_id, platform, status);
