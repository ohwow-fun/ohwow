-- =====================================================================
-- Migration 118: Rollback tracking on experiment_validations
--
-- Phase 5-A: close the validation feedback loop by letting the runner
-- auto-revert failed interventions. When validate() returns
-- outcome='failed' and the experiment exposes a rollback() hook, the
-- runner calls it, writes a rollback finding, and stamps the
-- validation row so queries can distinguish "failed but reverted"
-- from "failed and still bad."
--
-- Columns:
--   rolled_back          — 1 when a rollback ran successfully, else 0.
--                          Default 0 so legacy rows show as not-rolled-back.
--   rollback_finding_id  — FK to the self_findings row the runner wrote
--                          for the rollback. Pair with outcome_finding_id
--                          to get the full "validation said fail,
--                          rollback said X" trail.
--   rolled_back_at       — ISO timestamp when the rollback ran.
--
-- No schema change for Experiment implementations that don't need
-- rollback — the hook is optional on the interface.
-- =====================================================================

-- @statement
ALTER TABLE experiment_validations ADD COLUMN rolled_back INTEGER DEFAULT 0;
-- @statement
ALTER TABLE experiment_validations ADD COLUMN rollback_finding_id TEXT;
-- @statement
ALTER TABLE experiment_validations ADD COLUMN rolled_back_at TEXT;
-- @statement
CREATE INDEX IF NOT EXISTS idx_validations_rolled_back
  ON experiment_validations(rolled_back, validate_at DESC)
  WHERE rolled_back = 1;
