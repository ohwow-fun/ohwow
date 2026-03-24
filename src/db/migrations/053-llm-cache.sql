-- Agent OS: LLM Response Cache
-- Stores and retrieves LLM responses using BM25 similarity matching.

CREATE TABLE IF NOT EXISTS llm_response_cache (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  request_text TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  system_prompt_hash TEXT NOT NULL,
  response_content TEXT NOT NULL,
  response_tokens TEXT DEFAULT '{}',
  quality_score REAL DEFAULT 1.0,
  usage_count INTEGER DEFAULT 1,
  last_used_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_llm_cache_hash ON llm_response_cache(workspace_id, request_hash);
CREATE INDEX IF NOT EXISTS idx_llm_cache_usage ON llm_response_cache(workspace_id, usage_count DESC, last_used_at DESC);
