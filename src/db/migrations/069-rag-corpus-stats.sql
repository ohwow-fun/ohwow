-- ============================================================================
-- 069: RAG Corpus Statistics
--
-- Tracks per-term document frequency for IDF-aware BM25 scoring.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rag_corpus_stats (
  workspace_id TEXT NOT NULL,
  term TEXT NOT NULL,
  doc_frequency INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, term)
);

CREATE INDEX IF NOT EXISTS idx_rag_corpus_stats_workspace
  ON rag_corpus_stats(workspace_id);
