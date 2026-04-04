-- Entities extracted from knowledge chunks
CREATE TABLE IF NOT EXISTS knowledge_graph_entities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  entity_text TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kg_entities_workspace ON knowledge_graph_entities(workspace_id);
CREATE INDEX IF NOT EXISTS idx_kg_entities_chunk ON knowledge_graph_entities(chunk_id);
CREATE INDEX IF NOT EXISTS idx_kg_entities_text ON knowledge_graph_entities(workspace_id, entity_text);

-- Relationships between entities
CREATE TABLE IF NOT EXISTS knowledge_graph_edges (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  source_chunk_id TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kg_edges_workspace ON knowledge_graph_edges(workspace_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON knowledge_graph_edges(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON knowledge_graph_edges(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_chunk ON knowledge_graph_edges(source_chunk_id);
