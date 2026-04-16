-- 131-research-citations-ledger.sql
-- Durable citation ledger for research-driven self-improvement.
--
-- Tier 2 of the auto-observation loop. When a patch cites a paper
-- (via the `Cites-Research-Paper:` commit trailer) the runtime logs
-- a row here so we can later measure which sources actually produce
-- patches that hold vs. get reverted. Papers whose citations
-- consistently precede Layer 5 reverts get down-weighted in the
-- proposal generator over time.
--
-- A research paper can be cited by multiple commits (different
-- anomalies, different angles) so no uniqueness constraint across
-- paper_id alone. The UNIQUE index on (paper_id, commit_sha) keeps
-- the same commit from double-logging the same citation on retry.
--
-- Outcome transitions mirror patches_attempted_log: cited (fresh)
-- → held (surviving the validation window) | reverted (Layer 5
-- fired). The resolver experiment — not yet wired — reconciles this
-- against patches_attempted_log's outcome so the ledger stays
-- consistent without double-bookkeeping.
--
-- anomaly_code is the AnomalyCode the research fetch was seeded by
-- (see src/self-bench/anomaly-research-queries.ts). Nullable because
-- a human operator may cite a paper directly without going through
-- the anomaly → query flow.

CREATE TABLE IF NOT EXISTS research_citations_ledger (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  paper_title TEXT NOT NULL,
  paper_url TEXT,
  anomaly_code TEXT,
  commit_sha TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'cited'
    CHECK (outcome IN ('cited', 'held', 'reverted')),
  cited_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  UNIQUE (paper_id, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_research_citations_workspace_ts
  ON research_citations_ledger (workspace_id, cited_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_citations_paper
  ON research_citations_ledger (paper_id, outcome);
CREATE INDEX IF NOT EXISTS idx_research_citations_anomaly
  ON research_citations_ledger (anomaly_code, cited_at DESC);
