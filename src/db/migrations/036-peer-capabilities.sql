-- Add device capability columns to workspace_peers for capability-aware routing
-- @statement
ALTER TABLE workspace_peers ADD COLUMN total_memory_gb INTEGER;
-- @statement
ALTER TABLE workspace_peers ADD COLUMN cpu_cores INTEGER;
-- @statement
ALTER TABLE workspace_peers ADD COLUMN memory_tier TEXT;
-- @statement
ALTER TABLE workspace_peers ADD COLUMN is_apple_silicon INTEGER DEFAULT 0;
-- @statement
ALTER TABLE workspace_peers ADD COLUMN has_nvidia_gpu INTEGER DEFAULT 0;
-- @statement
ALTER TABLE workspace_peers ADD COLUMN gpu_name TEXT;
-- @statement
ALTER TABLE workspace_peers ADD COLUMN local_models TEXT DEFAULT '[]';
-- @statement
ALTER TABLE workspace_peers ADD COLUMN device_role TEXT DEFAULT 'hybrid';
-- @statement
ALTER TABLE workspace_peers ADD COLUMN machine_id TEXT;
