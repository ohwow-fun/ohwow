-- Agent OS: Task Checkpointing
-- Add checkpoint columns to tasks table for pause/resume support.
-- Note: these columns are also added in 048; the @statement directives
-- allow this migration to run idempotently if 048 was applied first.

-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN checkpoint TEXT DEFAULT NULL;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN checkpoint_iteration INTEGER DEFAULT NULL;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN pause_requested INTEGER DEFAULT 0;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN max_duration_seconds INTEGER DEFAULT NULL;
