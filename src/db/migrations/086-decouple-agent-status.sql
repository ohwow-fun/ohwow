-- =====================================================================
-- 086: Add paused column to agent_workforce_agents
--
-- Aligns local runtime with cloud schema (cloud migration 322).
-- Cloud replaced the status column with a paused boolean.
-- Local keeps status for internal execution tracking (working/idle)
-- but adds paused as the user-controlled kill switch.
-- =====================================================================

-- @statement
ALTER TABLE agent_workforce_agents ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;

-- @statement
UPDATE agent_workforce_agents SET paused = 1 WHERE status = 'paused';

-- @statement
CREATE INDEX IF NOT EXISTS idx_agents_paused ON agent_workforce_agents(paused) WHERE paused = 1;
