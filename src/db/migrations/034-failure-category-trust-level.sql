-- Failure category for error classification on tasks
ALTER TABLE agent_workforce_tasks ADD COLUMN failure_category TEXT DEFAULT NULL;

-- Trust level for memory source verification
ALTER TABLE agent_workforce_agent_memory ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'inferred';
