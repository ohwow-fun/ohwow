-- =====================================================================
-- Migration 123: insight distiller — novelty baselines + feedback ledger
--
-- Piece 1 of the "surprise-first self-observation" bundle. Raw findings
-- keep flowing into self_findings on the 5s reactive reschedule; this
-- migration adds the two tables that let the system tell "the 500th
-- identical repetition" apart from "an unusual thing just happened":
--
--   self_observation_baselines
--     One row per (experiment_id, subject) that accumulates a rolling
--     running mean + stddev over an optional numeric evidence field
--     (`tracked_field`) via Welford's algorithm. Also tracks first-seen
--     timestamp, sample count, last verdict, and consecutive fail
--     count — enough to answer "have we seen this before?" and "has
--     the verdict been stuck for a while?" without scanning the
--     ledger. Findings-store writes this row alongside every insert
--     and mixes the resulting novelty score into the finding's
--     evidence.__novelty so the distiller can rank by surprise.
--
--   self_insight_feedback
--     Operator / agent feedback ledger: accepted / rejected /
--     deferred / applied actions taken on a specific finding, keyed
--     by finding_id. Closes the loop so the strategist and
--     experiment-author can eventually learn which suggestions
--     actually landed well. Nothing writes here yet — the REST +
--     MCP surfaces for recording feedback come in a later piece;
--     this migration is the shape-only slice.
-- =====================================================================

-- @statement
CREATE TABLE IF NOT EXISTS self_observation_baselines (
  experiment_id     TEXT NOT NULL,
  subject           TEXT NOT NULL,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  sample_count      INTEGER NOT NULL DEFAULT 0,
  tracked_field     TEXT,
  running_mean      REAL,
  running_m2        REAL,
  last_value        REAL,
  last_verdict      TEXT,
  consecutive_fails INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (experiment_id, subject)
);

-- @statement
CREATE INDEX IF NOT EXISTS idx_baselines_last_seen
  ON self_observation_baselines(last_seen_at DESC);

-- @statement
CREATE INDEX IF NOT EXISTS idx_baselines_consecutive_fails
  ON self_observation_baselines(consecutive_fails DESC)
  WHERE consecutive_fails > 0;

-- @statement
CREATE TABLE IF NOT EXISTS self_insight_feedback (
  id         TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('accepted','rejected','deferred','applied')),
  actor      TEXT NOT NULL,
  rationale  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- @statement
CREATE INDEX IF NOT EXISTS idx_insight_feedback_finding
  ON self_insight_feedback(finding_id, created_at DESC);
