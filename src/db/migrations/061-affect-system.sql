-- Affect System: Somatic markers and affective memories (Damasio)
-- Emotions as fast decision heuristics

CREATE TABLE IF NOT EXISTS somatic_markers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  affect TEXT NOT NULL,
  valence REAL NOT NULL,
  intensity REAL NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('positive','negative','neutral')),
  tool_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_somatic_markers_context ON somatic_markers(workspace_id, context_hash);
CREATE INDEX IF NOT EXISTS idx_somatic_markers_tool ON somatic_markers(workspace_id, tool_name);

CREATE TABLE IF NOT EXISTS affective_memories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  experience_id TEXT NOT NULL,
  affect TEXT NOT NULL,
  valence REAL NOT NULL,
  arousal REAL NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_affective_memories_affect ON affective_memories(workspace_id, affect);
