-- Add delegation tracking columns to agent tasks
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN delegated_to_peer_id TEXT;
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN delegated_task_id TEXT;
