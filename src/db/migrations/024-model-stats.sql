-- Model detection and usage stats for Ollama models

CREATE TABLE IF NOT EXISTS ollama_model_snapshots (
  model_name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'installed' CHECK (status IN ('loaded', 'installed', 'unavailable')),
  size_bytes INTEGER,
  vram_bytes INTEGER,
  processor TEXT,
  quantization TEXT,
  family TEXT,
  expires_at TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ollama_model_stats (
  model_name TEXT PRIMARY KEY,
  total_requests INTEGER NOT NULL DEFAULT 0,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
