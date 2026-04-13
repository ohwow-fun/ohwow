-- Workspace-level default filesystem paths.
--
-- Without this, every agent that doesn't have an explicit row in
-- agent_file_access_paths fails every local_read_file/local_write_file call
-- with "No directories are configured for file access". The orchestrator
-- pseudo-agent has a hardcoded /tmp baseline (filesystem.ts) but real agents
-- inherit nothing, so SOP-delegated work that touches the disk silently fails.
--
-- engine.ts unions this column with per-agent paths when constructing the
-- FileAccessGuard, so workspace defaults flow to every task execution.
-- filesystem.ts reads the same column so orchestrator chat and agent task
-- execution share a single source of truth for "what /tmp-like paths are
-- always allowed."
--
-- Default value gives every existing workspace /tmp out of the box, matching
-- the prior orchestrator-only baseline.

ALTER TABLE agent_workforce_workspaces
  ADD COLUMN default_filesystem_paths TEXT NOT NULL DEFAULT '["/tmp"]';
