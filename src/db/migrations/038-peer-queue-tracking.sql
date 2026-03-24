-- Add queue tracking columns to workspace_peers for load-aware routing
-- @statement
ALTER TABLE workspace_peers ADD COLUMN queue_active INTEGER DEFAULT 0;
-- @statement
ALTER TABLE workspace_peers ADD COLUMN queue_waiting INTEGER DEFAULT 0;
