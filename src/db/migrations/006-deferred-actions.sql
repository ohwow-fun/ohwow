-- Add deferred_action column to tasks (mirrors Supabase JSONB column as TEXT)
-- @statement
ALTER TABLE agent_workforce_tasks ADD COLUMN deferred_action TEXT DEFAULT NULL;
