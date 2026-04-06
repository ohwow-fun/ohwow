-- ============================================================================
-- 079: Agent Mounted Docs
--
-- Adds mounted_docs column to agents for per-agent declarative doc mounts.
-- JSON array of documentation URLs to auto-mount on agent boot.
-- ============================================================================

ALTER TABLE agent_workforce_agents ADD COLUMN mounted_docs TEXT DEFAULT '[]';
