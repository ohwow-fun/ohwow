-- ============================================================================
-- 021: Unify Automations
--
-- Add trigger_type, trigger_config, and variables columns to local_triggers
-- so that all automation types (webhook, schedule, event, manual) can be
-- represented in a single table. Also adds support for agent_prompt and
-- a2a_call step types in the actions chain.
-- ============================================================================

ALTER TABLE local_triggers ADD COLUMN trigger_type TEXT DEFAULT 'webhook';
ALTER TABLE local_triggers ADD COLUMN trigger_config TEXT DEFAULT '{}';
ALTER TABLE local_triggers ADD COLUMN variables TEXT;
