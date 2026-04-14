-- =====================================================================
-- Migration 116: self_findings — structured ledger for self-experimentation
--
-- Phase 1 of the self-improvement loop. Every experiment run by the
-- ExperimentRunner writes a row here: what was tested, what the verdict
-- was, what intervention (if any) was applied, and what the evidence
-- looked like. This becomes:
--   1. The ground-truth record the next experiment reads before running
--      so the system doesn't re-investigate things it already knows.
--   2. The feedback substrate: E1's demotion cache, E2's trigger
--      watchdog, the upcoming canary suite, etc. all write findings so
--      every future Claude session (and every agent's own planning) can
--      query a uniform "what do we know about ourselves?" surface.
--   3. The input for the eventual meta-loop that picks the next
--      experiment to run based on what's unknown or drifting.
--
-- Nothing writes here yet after this migration — the writers land in
-- commit Phase1-B as part of the ExperimentRunner and its wrapper
-- experiments around E1/E2. This migration is the shape-only slice.
-- =====================================================================

-- @statement
CREATE TABLE IF NOT EXISTS self_findings (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  category TEXT NOT NULL,
  subject TEXT,
  hypothesis TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'warning', 'fail', 'error')),
  summary TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  intervention_applied TEXT,
  ran_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'revoked')),
  superseded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_findings_experiment ON self_findings(experiment_id, ran_at DESC);
-- @statement
CREATE INDEX IF NOT EXISTS idx_findings_category ON self_findings(category, ran_at DESC);
-- @statement
CREATE INDEX IF NOT EXISTS idx_findings_verdict ON self_findings(verdict, ran_at DESC) WHERE status = 'active';
-- @statement
CREATE INDEX IF NOT EXISTS idx_findings_subject ON self_findings(subject, ran_at DESC) WHERE subject IS NOT NULL;
