-- 132-llm-calls-experiment-id.sql
-- Attribute LLM calls to the self-bench experiment that triggered them.
--
-- llm_calls already tracks workspace_id, agent_id, task_id — enough to
-- attribute orchestrator/agent calls. Self-bench experiments call
-- runLlmCall directly without an agent_id, so today their cost is
-- invisible at the experiment level. The cost-observer experiment can't
-- ask "which experiments are spending without producing signal?"
-- because it can't tell experiment calls apart from each other.
--
-- This migration adds a nullable experiment_id column. Callers that
-- pass it (patch-author, roadmap-updater, ...) get rows attributed.
-- Existing callers that don't pass it write NULL and show up as
-- "(unattributed)" in rollups, so the column is purely additive — no
-- back-compat shim needed.
--
-- Index for the rollup's hot path: GROUP BY experiment_id over a 14d
-- window scoped to a single workspace.

-- @statement
ALTER TABLE llm_calls ADD COLUMN experiment_id TEXT DEFAULT NULL;

-- @statement
CREATE INDEX IF NOT EXISTS idx_llm_calls_experiment
  ON llm_calls (workspace_id, experiment_id, created_at DESC)
  WHERE experiment_id IS NOT NULL;
