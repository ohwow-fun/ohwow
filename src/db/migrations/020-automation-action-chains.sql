-- Migration 020: Add action chains to local triggers
-- Adds multi-step action support (Zapier-style linear chains)

ALTER TABLE local_triggers ADD COLUMN actions TEXT;
-- JSON array: [{ "id": "step_1", "action_type": "...", "action_config": {...}, "label": "..." }]
-- When null, evaluator falls back to legacy action_type/action_config columns

ALTER TABLE local_trigger_executions ADD COLUMN step_index INTEGER;
ALTER TABLE local_trigger_executions ADD COLUMN step_id TEXT;
