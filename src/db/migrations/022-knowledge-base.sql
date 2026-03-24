-- ============================================================================
-- 022: Knowledge Base
--
-- Adds knowledge document storage, chunking, and per-agent configuration
-- for the local (TUI) knowledge base feature.
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_workforce_knowledge_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  filename TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'upload',
  source_url TEXT,
  processing_status TEXT NOT NULL DEFAULT 'pending',
  processing_error TEXT,
  processed_at TEXT,
  compiled_text TEXT,
  compiled_token_count INTEGER DEFAULT 0,
  chunk_count INTEGER DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT,
  times_used INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_docs_workspace
  ON agent_workforce_knowledge_documents(workspace_id, is_active);

CREATE TABLE IF NOT EXISTS agent_workforce_knowledge_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES agent_workforce_knowledge_documents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  summary TEXT,
  keywords TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document
  ON agent_workforce_knowledge_chunks(document_id, chunk_index);

CREATE TABLE IF NOT EXISTS agent_workforce_knowledge_agent_config (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES agent_workforce_knowledge_documents(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  opted_out INTEGER NOT NULL DEFAULT 0,
  injection_mode TEXT NOT NULL DEFAULT 'auto',
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(document_id, agent_id)
);

ALTER TABLE agent_workforce_agents ADD COLUMN knowledge_document TEXT DEFAULT '';
ALTER TABLE agent_workforce_agents ADD COLUMN knowledge_token_count INTEGER DEFAULT 0;
