-- ============================================================================
-- 145: Qwen3 embedding provenance on knowledge chunks.
--
-- Migration 071 added a BLOB `embedding` column on
-- agent_workforce_knowledge_chunks, but only a document-level
-- `embedding_model` column on agent_workforce_knowledge_documents. That
-- was enough when a single Ollama model embedded the whole corpus at
-- once; the daemon could infer a chunk's model from its parent doc.
--
-- The in-daemon Qwen3 embedder changes that. The backfill worker runs
-- per-chunk, on its own schedule, and we need an idempotent "has this
-- chunk been embedded by the current model?" check without touching
-- the document row. Two new columns make that query a single WHERE
-- clause:
--
--   embedding_model      - the HF repo id that produced the vector
--                          (e.g. "onnx-community/Qwen3-Embedding-0.6B-ONNX").
--   embedding_updated_at - ISO timestamp so we can age out stale
--                          vectors later if the model changes.
--
-- Kept on the chunk (not the document) because the backfill worker
-- processes rows in batches across many documents and needs to resume
-- cleanly after a restart.
-- ============================================================================

ALTER TABLE agent_workforce_knowledge_chunks ADD COLUMN embedding_model TEXT;
ALTER TABLE agent_workforce_knowledge_chunks ADD COLUMN embedding_updated_at TEXT;
