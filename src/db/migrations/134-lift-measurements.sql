-- 134-lift-measurements.sql
-- Phase 5 of the "close the self-improvement loop" plan: credit assignment.
--
-- Today the autonomous author lands a commit, Layer 5 watches for a
-- regression, and if none surfaces within the cool-off window the
-- commit is declared "held." "Held" is necessary — the change didn't
-- break anything — but it's not sufficient: the whole point of an
-- autonomous loop pointed at a money telos is that commits should
-- MOVE outcome KPIs, not merely avoid breaking them.
--
-- lift_measurements is the ledger for outcome-measured commits.
-- When an autonomous commit is landed with an Expected-Lift trailer
-- (safeSelfCommit, Phase 5a), one row is inserted per (commit_sha,
-- kpi_id, horizon_hours) naming:
--
--   - expected_direction  — 'up' (raise a higher_is_better metric),
--                           'down' (raise a lower_is_better metric, i.e.
--                           reduce something like burn), or 'any' (the
--                           commit claims it will move the needle but
--                           doesn't commit to a direction — rare,
--                           used for neutral refactors that should at
--                           least not hurt)
--   - baseline_value      — KPI reading at commit time (immediately
--                           after safeSelfCommit lands). NULL when
--                           the read errored (the commit still lands;
--                           we record the gap so operators can spot
--                           flaky KPI readers).
--   - measure_at          — when the post-commit reading is due
--                           (baseline_at + horizon_hours). A later
--                           LiftMeasurementExperiment reads the KPI
--                           again and fills in post_value, signed_lift,
--                           and verdict.
--   - signed_lift         — post - baseline, normalized by higher_is_better
--                           (see kpi-registry.signedLift). A positive
--                           number always means "moved the right way."
--   - verdict             — 'moved_right' (signed_lift > 0),
--                           'moved_wrong' (signed_lift < 0),
--                           'flat' (|signed_lift| < tolerance),
--                           'unmeasured' (baseline or post read failed)
--
-- UNIQUE (workspace_id, commit_sha, kpi_id, horizon_hours) so the
-- same commit doesn't double-insert if safeSelfCommit retries the
-- baseline write. Each commit can register multiple horizons on the
-- same KPI (6h, 24h, 168h) as separate rows; a commit can also
-- register multiple KPIs.
--
-- Phase 5b (next) wires the ranker's weights against the observed
-- lift distribution so selection drift toward "commits that actually
-- move KPIs" is learned, not hand-tuned.

CREATE TABLE IF NOT EXISTS lift_measurements (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  kpi_id TEXT NOT NULL,
  expected_direction TEXT NOT NULL
    CHECK (expected_direction IN ('up', 'down', 'any')),
  horizon_hours INTEGER NOT NULL CHECK (horizon_hours > 0),
  baseline_value REAL,
  baseline_at TEXT NOT NULL,
  measure_at TEXT NOT NULL,
  post_value REAL,
  post_at TEXT,
  signed_lift REAL,
  verdict TEXT
    CHECK (verdict IN ('moved_right', 'moved_wrong', 'flat', 'unmeasured')),
  source_experiment_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, commit_sha, kpi_id, horizon_hours)
);

CREATE INDEX IF NOT EXISTS idx_lift_measure_pending
  ON lift_measurements (workspace_id, post_at, measure_at);
CREATE INDEX IF NOT EXISTS idx_lift_measure_commit
  ON lift_measurements (workspace_id, commit_sha);
CREATE INDEX IF NOT EXISTS idx_lift_measure_kpi
  ON lift_measurements (workspace_id, kpi_id, measure_at DESC);
