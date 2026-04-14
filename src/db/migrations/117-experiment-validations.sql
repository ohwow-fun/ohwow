-- =====================================================================
-- Migration 117: experiment_validations — accountability for interventions
--
-- Phase 3 of the self-improvement loop. Every time an Experiment's
-- intervene() mutates system state, the runner enqueues a validation
-- row to be processed ~15 minutes later. At validation time the
-- experiment's validate() hook reads the stored baseline, measures
-- current state, and returns held | failed | inconclusive. The outcome
-- lands as a self_findings row with category='validation' so queries
-- can trace "what the system decided and whether it was right."
--
-- Without this table, an intervention vanishes into history the moment
-- it's applied — there's no way to tell tomorrow whether yesterday's
-- stale-task-cleanup actually unblocked the queue or the queue filled
-- up again with new zombies. The validation step is the feedback loop
-- that makes every intervention a measurable claim instead of a
-- fire-and-forget side effect.
--
-- Columns:
--   intervention_finding_id — the self_findings row that carried the
--                             original intervention_applied blob.
--   experiment_id           — the experiment that owns the validate()
--                             hook. The runner looks it up in the live
--                             registry at validation time.
--   baseline                — JSON snapshot captured from the
--                             intervention's details. This is what the
--                             validate() function gets as its first
--                             argument.
--   validate_at             — ISO timestamp when the runner should fire
--                             the validation. Indexed so the due-query
--                             stays cheap.
--   status                  — pending | completed | skipped | error
--                             ('skipped' = experiment no longer has
--                             validate() by the time the row is due)
--   outcome                 — held | failed | inconclusive — null until
--                             validation fires.
--   outcome_finding_id      — self_findings row the validation wrote.
-- =====================================================================

-- @statement
CREATE TABLE IF NOT EXISTS experiment_validations (
  id TEXT PRIMARY KEY,
  intervention_finding_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  baseline TEXT NOT NULL DEFAULT '{}',
  validate_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'skipped', 'error')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('held', 'failed', 'inconclusive')),
  outcome_finding_id TEXT,
  error_message TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_validations_due
  ON experiment_validations(validate_at)
  WHERE status = 'pending';
-- @statement
CREATE INDEX IF NOT EXISTS idx_validations_experiment
  ON experiment_validations(experiment_id, created_at DESC);
-- @statement
CREATE INDEX IF NOT EXISTS idx_validations_intervention
  ON experiment_validations(intervention_finding_id);
