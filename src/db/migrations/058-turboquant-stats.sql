-- TurboQuant KV cache compression statistics
-- Tracks compression performance per model for monitoring and display

CREATE TABLE IF NOT EXISTS turboquant_stats (
  model_name TEXT PRIMARY KEY,
  compression_ratio REAL,
  effective_context_tokens INTEGER,
  baseline_context_tokens INTEGER,
  bits_per_value INTEGER DEFAULT 4,
  last_updated TEXT DEFAULT (datetime('now'))
);
