-- =====================================================================
-- Migration 048: Tasks Column Alignment
-- Add missing columns that exist in cloud but not locally
-- =====================================================================

-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN assigned_to TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN assignee_type TEXT DEFAULT 'agent';
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN assigned_by TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN assigned_at TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN context_notes TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN source_type TEXT DEFAULT 'manual';
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN source_signal TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN sipoc_trace TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN truth_score INTEGER;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN truth_score_details TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN session_id TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN checkpoint TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN checkpoint_iteration INTEGER;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN max_duration_seconds INTEGER;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN pause_requested INTEGER DEFAULT 0;
-- @statement
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status ON agent_workforce_tasks(workspace_id, status);
