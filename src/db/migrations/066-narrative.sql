-- Narrative: Story of self (Ricoeur + MacIntyre)
-- Agents gain identity through narrative coherence

CREATE TABLE IF NOT EXISTS narrative_episodes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  agent_id TEXT,
  story_type TEXT NOT NULL,
  title TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'beginning',
  events TEXT NOT NULL DEFAULT '[]',
  moral TEXT,
  emotional_arc TEXT DEFAULT '[]',
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_narrative_episodes_agent ON narrative_episodes(workspace_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_narrative_episodes_phase ON narrative_episodes(workspace_id, phase);

CREATE TABLE IF NOT EXISTS character_profiles (
  id TEXT PRIMARY KEY DEFAULT 'default',
  workspace_id TEXT NOT NULL,
  agent_id TEXT,
  identity TEXT NOT NULL DEFAULT '',
  core_traits TEXT DEFAULT '[]',
  defining_moments TEXT DEFAULT '[]',
  narrative_coherence REAL DEFAULT 0.5,
  updated_at TEXT DEFAULT (datetime('now'))
);
