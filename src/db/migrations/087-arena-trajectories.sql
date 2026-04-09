-- =====================================================================
-- 087: Arena training trajectories
--
-- Stores structured recordings of agent episodes in Arena environments.
-- Each trajectory captures the full step-by-step execution trace
-- including tools used, rewards, and success/failure signals.
-- =====================================================================

-- @statement
CREATE TABLE IF NOT EXISTS arena_trajectories (
  id TEXT PRIMARY KEY,
  arena_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'unknown',
  workspace_id TEXT NOT NULL DEFAULT 'default',
  steps TEXT NOT NULL DEFAULT '[]',
  total_reward REAL NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- @statement
CREATE INDEX IF NOT EXISTS idx_arena_traj_arena ON arena_trajectories(arena_id);

-- @statement
CREATE INDEX IF NOT EXISTS idx_arena_traj_agent ON arena_trajectories(agent_id);

-- @statement
CREATE INDEX IF NOT EXISTS idx_arena_traj_workspace ON arena_trajectories(workspace_id);
