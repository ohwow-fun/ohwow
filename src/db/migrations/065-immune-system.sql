-- Immune System: Layered threat defense with innate and adaptive immunity
-- Maturana & Varela's autopoiesis + self/non-self distinction

CREATE TABLE IF NOT EXISTS threat_signatures (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  pathogen_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  severity REAL NOT NULL DEFAULT 0.5,
  origin TEXT NOT NULL DEFAULT 'learned',
  false_positive_rate REAL NOT NULL DEFAULT 0.1,
  last_seen TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_threat_signatures_workspace ON threat_signatures(workspace_id, origin);

CREATE TABLE IF NOT EXISTS immune_memories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  pathogen_type TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  last_occurrence TEXT NOT NULL,
  response_effectiveness REAL NOT NULL DEFAULT 0.5,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_immune_memories_workspace ON immune_memories(workspace_id, context_hash);

CREATE TABLE IF NOT EXISTS immune_incidents (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  pathogen_type TEXT NOT NULL,
  confidence REAL NOT NULL,
  recommendation TEXT NOT NULL,
  matched_signature TEXT,
  reason TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_immune_incidents_time ON immune_incidents(workspace_id, created_at DESC);
