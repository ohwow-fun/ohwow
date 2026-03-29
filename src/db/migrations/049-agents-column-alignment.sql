-- =====================================================================
-- Migration 049: Agents Column Alignment
-- Add missing columns that exist in cloud but not locally
-- =====================================================================

-- @statement
ALTER TABLE agent_workforce_agents ADD COLUMN sipoc_profile TEXT;
-- @statement
ALTER TABLE agent_workforce_agents ADD COLUMN autonomy_level INTEGER DEFAULT 2;
-- @statement
ALTER TABLE agent_workforce_agents ADD COLUMN autonomy_budget TEXT;
-- @statement
ALTER TABLE agent_workforce_agents ADD COLUMN point_person_id TEXT;
-- @statement
ALTER TABLE agent_workforce_agents ADD COLUMN archived_at TEXT;
-- @statement
ALTER TABLE agent_workforce_agents ADD COLUMN total_tasks INTEGER DEFAULT 0;
-- @statement
ALTER TABLE agent_workforce_agents ADD COLUMN completed_tasks INTEGER DEFAULT 0;
-- @statement
ALTER TABLE agent_workforce_agents ADD COLUMN failed_tasks INTEGER DEFAULT 0;
-- @statement
ALTER TABLE agent_workforce_agents ADD COLUMN tokens_used INTEGER DEFAULT 0;
-- @statement
ALTER TABLE agent_workforce_agents ADD COLUMN cost_cents_total INTEGER DEFAULT 0;
