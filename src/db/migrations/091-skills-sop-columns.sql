-- Add columns for SOP system: trigger matching, usage tracking, and cloud sync
-- These columns already exist in the cloud Supabase schema but were missing locally.

ALTER TABLE agent_workforce_skills ADD COLUMN triggers TEXT DEFAULT '[]';
ALTER TABLE agent_workforce_skills ADD COLUMN times_used INTEGER DEFAULT 0;
ALTER TABLE agent_workforce_skills ADD COLUMN success_rate REAL;
ALTER TABLE agent_workforce_skills ADD COLUMN last_used_at TEXT;
ALTER TABLE agent_workforce_skills ADD COLUMN updated_at TEXT;
ALTER TABLE agent_workforce_skills ADD COLUMN locality_policy TEXT DEFAULT 'sync';
ALTER TABLE agent_workforce_skills ADD COLUMN source_device_id TEXT;

ALTER TABLE agent_workforce_discovered_processes ADD COLUMN trigger_message TEXT;
ALTER TABLE agent_workforce_discovered_processes ADD COLUMN last_auto_executed_at TEXT;
ALTER TABLE agent_workforce_discovered_processes ADD COLUMN auto_execute_count INTEGER DEFAULT 0;
ALTER TABLE agent_workforce_discovered_processes ADD COLUMN updated_at TEXT;
ALTER TABLE agent_workforce_discovered_processes ADD COLUMN locality_policy TEXT DEFAULT 'sync';
ALTER TABLE agent_workforce_discovered_processes ADD COLUMN source_device_id TEXT;
