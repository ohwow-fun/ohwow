-- Add node_positions column to local_triggers for storing flow builder layout
ALTER TABLE local_triggers ADD COLUMN node_positions TEXT;
