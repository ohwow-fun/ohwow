-- 144-director-arcs.sql
-- Director-tier persistence (autonomy arc Phase 4).
--
-- Three tables that record the Director's view of an arc:
--   * director_arcs           — one open row per workspace; budget caps,
--                                pulse-at-entry/close snapshot, exit reason.
--   * director_phase_reports  — one row per phase the Director ran inside
--                                the arc; carries the 5-line phase report
--                                contract (status, trios_run, SHA pair,
--                                pulse delta, raw_report) plus cost roll-up.
--   * founder_inbox           — process questions raised mid-phase that
--                                require the founder to unblock. Local-only
--                                in this phase; cloud sync is later work.
--
-- See `docs/autonomy-architecture.md` "Director arc state" and
-- "Founder inbox semantics".
--
-- FK note: SQLite cannot ALTER an existing table to add FKs. Migration
-- 143 left `phase_trios.phase_id` as a free-form TEXT id (no FK) so this
-- migration does not have to rebuild that table; the soft reference is
-- enough for the orchestrator. The new tables can declare FKs internally
-- (director_phase_reports.arc_id and founder_inbox.arc_id both REFERENCE
-- director_arcs(id)).
--
-- JSON columns (`pulse_at_entry`, `pulse_at_close`, `delta_pulse_json`,
-- `delta_ledger`, `inbox_added`, `options_json`) are TEXT — the Director
-- stringifies on write and accepts both string-and-parsed shapes on read.

-- @statement
CREATE TABLE IF NOT EXISTS director_arcs (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL,
  opened_at                TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at                TEXT,
  mode_of_invocation       TEXT NOT NULL,
  thesis                   TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','aborted')),
  budget_max_phases        INTEGER NOT NULL DEFAULT 6,
  budget_max_minutes       INTEGER NOT NULL DEFAULT 240,
  budget_max_inbox_qs      INTEGER NOT NULL DEFAULT 3,
  kill_on_pulse_regression INTEGER NOT NULL DEFAULT 1,
  pulse_at_entry           TEXT NOT NULL,
  pulse_at_close           TEXT,
  exit_reason              TEXT
);

-- @statement
CREATE INDEX IF NOT EXISTS idx_director_arcs_open
  ON director_arcs(workspace_id, status, opened_at DESC);

-- @statement
CREATE TABLE IF NOT EXISTS director_phase_reports (
  id                          TEXT PRIMARY KEY,
  arc_id                      TEXT NOT NULL REFERENCES director_arcs(id),
  workspace_id                TEXT NOT NULL,
  phase_id                    TEXT NOT NULL,
  mode                        TEXT NOT NULL CHECK (mode IN ('revenue','polish','plumbing','tooling')),
  goal                        TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN ('queued','in-flight','phase-closed','phase-partial','phase-blocked-on-founder','phase-aborted','rolled-back')),
  trios_run                   INTEGER NOT NULL DEFAULT 0,
  runtime_sha_start           TEXT,
  runtime_sha_end             TEXT,
  cloud_sha_start             TEXT,
  cloud_sha_end               TEXT,
  delta_pulse_json            TEXT,
  delta_ledger                TEXT,
  inbox_added                 TEXT,
  remaining_scope             TEXT,
  next_phase_recommendation   TEXT,
  cost_trios                  INTEGER,
  cost_minutes                INTEGER,
  cost_llm_cents              INTEGER,
  raw_report                  TEXT,
  started_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at                    TEXT
);

-- @statement
CREATE INDEX IF NOT EXISTS idx_phase_reports_arc
  ON director_phase_reports(arc_id, started_at DESC);

-- @statement
CREATE INDEX IF NOT EXISTS idx_phase_reports_ws_status
  ON director_phase_reports(workspace_id, status, started_at DESC);

-- @statement
CREATE TABLE IF NOT EXISTS founder_inbox (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  arc_id          TEXT REFERENCES director_arcs(id),
  phase_id        TEXT,
  mode            TEXT NOT NULL,
  blocker         TEXT NOT NULL,
  context         TEXT NOT NULL,
  options_json    TEXT NOT NULL,
  recommended     TEXT,
  screenshot_path TEXT,
  asked_at        TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at     TEXT,
  answer          TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','resolved','expired'))
);

-- @statement
CREATE INDEX IF NOT EXISTS idx_inbox_workspace_open
  ON founder_inbox(workspace_id, status, asked_at DESC);

-- @statement
CREATE INDEX IF NOT EXISTS idx_inbox_arc_open
  ON founder_inbox(arc_id, status);
