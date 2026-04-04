-- =====================================================================
-- Migration 072: Biological Org Hierarchy + Budget Guard
-- Extends departments into organ systems with purpose and nesting.
-- Adds agent synapses for biological agent-to-agent connections.
-- =====================================================================

-- Organ system extensions: purpose, nesting, type classification
-- @statement
ALTER TABLE agent_workforce_departments ADD COLUMN telos TEXT;
-- @statement
ALTER TABLE agent_workforce_departments ADD COLUMN parent_id TEXT;
-- @statement
ALTER TABLE agent_workforce_departments ADD COLUMN system_type TEXT DEFAULT 'organ_system';

-- Agent-to-agent synaptic connections
-- Directed, typed, strength-decaying connections between agents.
-- Types:
--   coordination = bidirectional, fast (nervous system signal)
--   delegation   = one-way task assignment (efferent signal)
--   nurture      = mentor/mentee growth (growth hormone)
--   symbiotic    = mutualistic, both benefit (emergent from collaboration)
--   immune       = one monitors the other's outputs (watchdog)
-- @statement
CREATE TABLE IF NOT EXISTS agent_synapses (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  synapse_type TEXT NOT NULL CHECK (synapse_type IN ('coordination','delegation','nurture','symbiotic','immune')),
  strength REAL DEFAULT 0.5,
  origin TEXT DEFAULT 'configured' CHECK (origin IN ('configured','emergent','hybrid')),
  evidence TEXT DEFAULT '[]',
  last_activated TEXT,
  activation_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, source_agent_id, target_agent_id, synapse_type)
);

-- @statement
CREATE INDEX IF NOT EXISTS idx_synapses_source ON agent_synapses(source_agent_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_synapses_target ON agent_synapses(target_agent_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_synapses_workspace ON agent_synapses(workspace_id);
