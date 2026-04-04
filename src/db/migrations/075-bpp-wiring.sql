-- BPP Wiring — Soul persistence, homeostasis action log, immune state transitions
-- Supports Phase 6 of the BPP hot-path integration.

-- Soul snapshots: periodic persistence of agent identity computation
CREATE TABLE IF NOT EXISTS soul_snapshots (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  soul TEXT NOT NULL,                    -- JSON: full AgentSoul object
  confidence REAL NOT NULL DEFAULT 0,
  emerging_identity TEXT,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_soul_snapshots_agent ON soul_snapshots(agent_id, workspace_id, computed_at);

-- Homeostasis action log: audit trail of corrective actions taken
CREATE TABLE IF NOT EXISTS homeostasis_action_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  action_type TEXT NOT NULL,
  reason TEXT,
  severity REAL NOT NULL DEFAULT 0,
  outcome TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_homeostasis_actions_ws ON homeostasis_action_log(workspace_id, created_at);

-- Immune state transitions: track alert level escalation/de-escalation
CREATE TABLE IF NOT EXISTS immune_state_transitions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  from_level TEXT NOT NULL,
  to_level TEXT NOT NULL,
  trigger_incident_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_immune_transitions_ws ON immune_state_transitions(workspace_id, created_at);
