-- 031-task-metadata.sql
-- Add metadata column to tasks for storing runtime flags (e.g. fallback_assignment)

ALTER TABLE agent_workforce_tasks ADD COLUMN metadata TEXT DEFAULT '{}';
