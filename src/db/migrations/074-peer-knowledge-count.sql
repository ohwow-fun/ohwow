-- Track knowledge chunk count per peer for mesh-distributed RAG routing.
-- Peers with more knowledge chunks are queried first.
ALTER TABLE workspace_peers ADD COLUMN knowledge_chunk_count INTEGER NOT NULL DEFAULT 0;
