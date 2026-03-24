-- Add definition column (mirrors cloud agent_workforce_workflows.definition)
-- Stores { steps: AutomationStep[], variables, node_positions } as JSON
ALTER TABLE local_triggers ADD COLUMN definition TEXT;

-- Add status column (mirrors cloud: draft/active/paused/archived)
ALTER TABLE local_triggers ADD COLUMN status TEXT DEFAULT 'active';
