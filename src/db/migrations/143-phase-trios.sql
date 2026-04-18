-- 143-phase-trios.sql
-- Phase orchestrator persistence (autonomy arc Phase 3).
--
-- Two tables that record every Trio + Round the phase orchestrator runs.
-- The Director tier (Phase 4) will add `director_arcs` and
-- `director_phase_reports`; until then, `phase_trios.phase_id` is a
-- free-form TEXT id (e.g. "p_2026-04-18-tooling-1") with no FK
-- constraint. Phase 4 wires the FK in a follow-up migration.
--
-- See `docs/autonomy-architecture.md` "Director arc state" for the full
-- shape — this migration ships only the trio + round half. The spec
-- originally numbered this 147; renumbered to 143 to slot after the
-- last live migration (142-x-reply-drafts.sql).
--
-- phase_rounds stores `findings_written`, `commits`, and
-- `evaluation_json` as JSON text columns; `raw_return` keeps the full
-- serialised RoundReturn for forensics. The `status` column is the
-- RoundStatus the round returned ('continue' / 'needs-input' /
-- 'blocked' / 'done'); we don't CHECK it because round-runner already
-- validates the shape before we ever write here.

CREATE TABLE IF NOT EXISTS phase_trios (
  id TEXT PRIMARY KEY,
  phase_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('revenue', 'polish', 'plumbing', 'tooling')),
  outcome TEXT NOT NULL CHECK (outcome IN ('successful', 'regressed', 'blocked', 'awaiting-founder', 'in-flight')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_phase_trios_phase
  ON phase_trios (phase_id, started_at DESC);

CREATE TABLE IF NOT EXISTS phase_rounds (
  id TEXT PRIMARY KEY,
  trio_id TEXT NOT NULL REFERENCES phase_trios(id),
  kind TEXT NOT NULL CHECK (kind IN ('plan', 'impl', 'qa')),
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  findings_written TEXT,
  commits TEXT,
  evaluation_json TEXT,
  raw_return TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_phase_rounds_trio
  ON phase_rounds (trio_id, started_at);
