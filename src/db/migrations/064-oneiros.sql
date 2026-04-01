-- Oneiros: Sleep, dreams, and default mode (Aristotle + Jung + DMN)
-- Consolidation, creative recombination, and idle-time processing

CREATE TABLE IF NOT EXISTS sleep_state (
  id TEXT PRIMARY KEY DEFAULT 'default',
  workspace_id TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'wake',
  sleep_debt REAL NOT NULL DEFAULT 0,
  last_consolidation TEXT,
  last_dream TEXT,
  cycle_count INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dream_associations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  memory_a_id TEXT NOT NULL,
  memory_b_id TEXT NOT NULL,
  connection TEXT NOT NULL,
  novelty_score REAL NOT NULL,
  promoted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dream_associations_novelty ON dream_associations(workspace_id, novelty_score DESC);
