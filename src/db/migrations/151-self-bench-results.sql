-- Self-bench experiment result log.
-- Tracks which A/B comparisons the system has run and their outcomes,
-- so future experiment selection avoids redundant comparisons.
CREATE TABLE IF NOT EXISTS self_bench_results (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id    TEXT NOT NULL,
  experiment_id   TEXT NOT NULL,
  config_a        TEXT NOT NULL,
  config_b        TEXT NOT NULL,
  winner          TEXT,
  score_a         REAL,
  score_b         REAL,
  verdict         TEXT,
  raw_json        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_self_bench_workspace
  ON self_bench_results(workspace_id, created_at DESC);
