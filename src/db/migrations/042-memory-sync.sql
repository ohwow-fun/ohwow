-- Memory Sync Support
-- Adds confidentiality classification, sync policy, device tracking, and local-only flag
-- to support privacy-aware memory synchronization between local and cloud.

-- 1. Add confidentiality_level to memory entries (derived from taint tracker labels)
ALTER TABLE agent_workforce_agent_memory
  ADD COLUMN confidentiality_level TEXT NOT NULL DEFAULT 'workspace'
  CHECK (confidentiality_level IN ('public', 'workspace', 'confidential', 'secret'));

-- 2. Add source_device_id to track which device created the memory
ALTER TABLE agent_workforce_agent_memory
  ADD COLUMN source_device_id TEXT DEFAULT NULL;

-- 3. Add is_local_only flag — user can mark individual memories as never-syncable
ALTER TABLE agent_workforce_agent_memory
  ADD COLUMN is_local_only INTEGER NOT NULL DEFAULT 0;

-- 4. Add source_agent_id for cross-agent memory provenance tracking
ALTER TABLE agent_workforce_agent_memory
  ADD COLUMN source_agent_id TEXT DEFAULT NULL;

-- 5. Add memory_sync_policy to agent configs (per-agent sync control)
--    'none' = all memories stay local (default)
--    'behavioral' = sync skills, feedback, procedures, efficiency only
--    'full' = sync all memory types
ALTER TABLE agent_workforce_agents
  ADD COLUMN memory_sync_policy TEXT NOT NULL DEFAULT 'none'
  CHECK (memory_sync_policy IN ('none', 'behavioral', 'full'));

-- 6. Add workspace-level memory sync master switch
INSERT OR IGNORE INTO runtime_settings (key, value, updated_at)
VALUES ('memory_sync_enabled', 'false', datetime('now'));

-- 7. Index for sync queries (find syncable memories by device)
CREATE INDEX IF NOT EXISTS idx_memory_sync
  ON agent_workforce_agent_memory (source_device_id, is_local_only, confidentiality_level)
  WHERE is_active = 1;

-- 8. Add orchestrator memory confidentiality (same classification)
ALTER TABLE orchestrator_memory
  ADD COLUMN confidentiality_level TEXT NOT NULL DEFAULT 'workspace'
  CHECK (confidentiality_level IN ('public', 'workspace', 'confidential', 'secret'));

ALTER TABLE orchestrator_memory
  ADD COLUMN is_local_only INTEGER NOT NULL DEFAULT 0;
