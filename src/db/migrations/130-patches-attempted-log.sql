-- 130-patches-attempted-log.sql
-- Durable "patch already tried" log for the autonomous author.
--
-- Today a reverted patch can resurface: patch-author reads the same
-- finding the next tick, the LLM emits substantially the same bytes,
-- safeSelfCommit lands the same change, the Layer 5 auto-revert fires
-- again. The cycle can burn model budget forever if a particular
-- (finding, file-shape) pair is ill-posed.
--
-- patches_attempted_log captures the outcome of every autonomous
-- patch attempt so the author can refuse to propose the same
-- (finding, file-hash) shape within a lookback window. Hash is
-- SHA-256 over the sorted, normalized list of paths touched in the
-- attempt. Outcome transitions: pending (just committed) → held
-- (survived the validation window) | reverted (Layer 5 fired, or
-- the operator did).
--
-- UNIQUE on (workspace_id, finding_id, file_paths_hash) so the same
-- attempt never double-inserts on retry. A new attempt at the same
-- shape is a distinct row only if its file_paths_hash differs; a
-- pure retry (same files, same finding) upserts into the existing
-- row via the helper, not a second row.

CREATE TABLE IF NOT EXISTS patches_attempted_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  file_paths_hash TEXT NOT NULL,
  commit_sha TEXT,
  outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'held', 'reverted')),
  proposed_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  patch_mode TEXT,
  tier TEXT,
  UNIQUE (workspace_id, finding_id, file_paths_hash)
);

CREATE INDEX IF NOT EXISTS idx_patches_attempted_workspace_ts
  ON patches_attempted_log (workspace_id, proposed_at DESC);
CREATE INDEX IF NOT EXISTS idx_patches_attempted_outcome
  ON patches_attempted_log (workspace_id, outcome, proposed_at DESC);
CREATE INDEX IF NOT EXISTS idx_patches_attempted_commit
  ON patches_attempted_log (commit_sha);
