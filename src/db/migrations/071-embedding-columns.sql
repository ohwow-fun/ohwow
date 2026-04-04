-- ============================================================================
-- 071: Embedding Columns for Knowledge Chunks
--
-- Adds vector embedding storage to enable hybrid BM25 + semantic search.
-- ============================================================================

ALTER TABLE agent_workforce_knowledge_chunks ADD COLUMN embedding BLOB;

ALTER TABLE agent_workforce_knowledge_documents ADD COLUMN embedding_model TEXT;
