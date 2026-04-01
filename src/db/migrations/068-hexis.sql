-- Hexis: Habit formation (Aristotle's hexis + William James)
-- Cue-routine-reward loop with automaticity gradient

CREATE TABLE IF NOT EXISTS habits (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cue TEXT NOT NULL,
  routine TEXT NOT NULL,
  reward TEXT NOT NULL,
  strength REAL NOT NULL DEFAULT 0.1,
  automaticity TEXT NOT NULL DEFAULT 'deliberate',
  success_rate REAL DEFAULT 0.5,
  execution_count INTEGER DEFAULT 0,
  last_executed TEXT,
  decay_rate REAL DEFAULT 0.03,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_habits_strength ON habits(workspace_id, strength DESC);

CREATE TABLE IF NOT EXISTS habit_executions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  habit_id TEXT NOT NULL,
  success INTEGER NOT NULL,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_habit_executions_habit ON habit_executions(habit_id, created_at DESC);
