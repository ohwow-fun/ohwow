-- =====================================================================
-- Migration 050: Workflows Trigger Alignment
-- Add missing trigger/automation columns from cloud schema
-- =====================================================================

-- @statement
ALTER TABLE agent_workforce_workflows ADD COLUMN definition TEXT DEFAULT '{}';
-- @statement
ALTER TABLE agent_workforce_workflows ADD COLUMN graph_definition TEXT;
-- @statement
ALTER TABLE agent_workforce_workflows ADD COLUMN trigger_type TEXT DEFAULT 'manual';
-- @statement
ALTER TABLE agent_workforce_workflows ADD COLUMN trigger_config TEXT DEFAULT '{}';
-- @statement
ALTER TABLE agent_workforce_workflows ADD COLUMN enabled INTEGER DEFAULT 1;
-- @statement
ALTER TABLE agent_workforce_workflows ADD COLUMN cooldown_seconds INTEGER DEFAULT 0;
-- @statement
ALTER TABLE agent_workforce_workflows ADD COLUMN last_fired_at TEXT;
-- @statement
ALTER TABLE agent_workforce_workflows ADD COLUMN fire_count INTEGER DEFAULT 0;
-- @statement
ALTER TABLE agent_workforce_workflows ADD COLUMN sample_payload TEXT;
-- @statement
ALTER TABLE agent_workforce_workflows ADD COLUMN sample_fields TEXT;
