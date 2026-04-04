# RAG Enhancement Plan for ohwow

## Current State

All three phases are **complete**. The ohwow RAG pipeline now includes:

### Phase 1: Foundation (Complete)
- **IDF-aware BM25** — proper term frequency weighting via `rag_corpus_stats` table
- **Connector interface** — `DataSourceConnector` / `ConnectorRegistry` abstraction
- **Hybrid vector+keyword search** — Ollama embeddings with cosine similarity, configurable BM25 weight
- **Query expansion** — LLM-based alternative phrasings via Ollama

### Phase 2: Structural (Complete)
- **Smart chunker** — markdown-aware splitting, code block preservation, configurable overlap (`src/lib/rag/chunker.ts`)
- **OpenAI-compatible provider** — generic provider for vLLM, Together, Groq, or any `/v1/chat/completions` server
- **LLM-based reranker** — opt-in passage rescoring for top-20 candidates (`rerankerEnabled` config)
- **Background document worker** — async processing queue for large documents (>50KB threshold)
- **GitHub + Local Files connectors** — first-party data source implementations
- **Automatic connector sync scheduling** — periodic sync based on `sync_interval_minutes`

### Phase 3: Intelligence (Complete)
- **Hybrid research** — `deepResearch` merges local knowledge + web search results
- **Knowledge graph** — entity extraction (heuristic NER + Ollama), relationship edges, graph-boosted retrieval
- **Google Drive + Notion connectors** — REST API based, no external dependencies
- **Mesh-distributed RAG** — cross-device knowledge retrieval via peer queries

---

## Architecture

```
User Query
    |
    v
Orchestrator (searchKnowledge / deepResearch)
    |
    +---> [LOCAL] retrieveKnowledgeChunks()
    |       +---> BM25 scoring (with IDF from corpus stats)
    |       +---> Hybrid scoring (BM25 + embedding cosine)
    |       +---> Query expansion (Ollama LLM)
    |       +---> Reranking (Ollama LLM, opt-in)
    |       +---> Knowledge graph boost (+0.1 for graph-connected chunks)
    |
    +---> [MESH] retrieveFromMesh() (opt-in)
    |       +---> Query top 3 peers in parallel
    |       +---> 0.9x score penalty for remote results
    |       +---> Dedup + merge with local results
    |
    +---> [WEB] web search (deepResearch only)
    |
    v
Budget selection (token budget + max chunks)
    |
    v
Results
```

### Document Ingestion Pipeline

```
Upload / URL / Connector Sync
    |
    v
< 50KB? --yes--> Synchronous processing
    |
    no
    |
    v
Enqueue to document_processing_queue
    |
    v
DocumentWorker (polls every 5s)
    +---> Extract text
    +---> Chunk (markdown-aware, overlap)
    +---> Save chunks
    +---> Update corpus stats (batched)
    +---> Generate embeddings (Ollama)
    +---> Extract knowledge graph (heuristic NER + Ollama, parallel)
```

---

## Configuration Reference

| Config Key | Env Var | Default | Description |
|-----------|---------|---------|-------------|
| `embeddingModel` | `OHWOW_EMBEDDING_MODEL` | `nomic-embed-text` | Ollama model for embeddings. Empty to disable. |
| `ragBm25Weight` | `OHWOW_RAG_BM25_WEIGHT` | `0.5` | BM25 weight in hybrid score (0.0 = pure embedding, 1.0 = pure BM25) |
| `rerankerEnabled` | `OHWOW_RERANKER_ENABLED` | `false` | Enable LLM-based reranking. Adds ~2-5s latency per search. |
| `meshRagEnabled` | `OHWOW_MESH_RAG_ENABLED` | `false` | Enable cross-device knowledge retrieval. Adds up to 10s latency. |
| `openaiCompatibleUrl` | `OHWOW_OPENAI_COMPATIBLE_URL` | `` | Base URL for OpenAI-compatible provider. Empty to disable. |
| `openaiCompatibleApiKey` | `OHWOW_OPENAI_COMPATIBLE_API_KEY` | `` | API key for OpenAI-compatible provider. |

### Mesh RAG Notes

- `meshRagEnabled` adds up to 10s latency on search (peer query timeout)
- Recommended only when 2+ peers have substantial knowledge bases
- Mesh gets 1/3 of token budget; local results always dominate
- Remote chunks receive a 0.9x score penalty to prefer local knowledge

---

## Available Connectors

| Type | Settings | Auth |
|------|----------|------|
| `github` | `repo`, `token?`, `branch?`, `paths?` | Personal access token |
| `local-files` | `path`, `patterns?`, `recursive?` | Filesystem access |
| `google-drive` | `folderId?`, `oauthToken?`, `mimeTypes?` | OAuth token |
| `notion` | `apiKey`, `databaseIds?`, `pageIds?` | Integration API key |

Connectors sync automatically based on `sync_interval_minutes` (default: 30). Manual sync available via the `sync_connector` tool.

---

## Design Principles

1. **Every enhancement works offline** — embeddings via Ollama, chunking is pure local, query expansion falls back gracefully
2. **Graceful degradation** — if Ollama is down, BM25 still works; if embeddings missing for a chunk, skip cosine; if mesh unavailable, local only
3. **Respect the philosophical architecture** — RAG integrates through Brain's `GlobalWorkspace`, connectors flow through Body's `DigitalNervousSystem`
4. **Reuse existing patterns** — `ChannelRegistry` for connector registry, `HeartbeatCoordinator` for background workers, `TypedEventBus` for progress
5. **No heavy dependencies** — no external search engines, message brokers, or task queues. SQLite + Ollama + Node.js workers keep the footprint minimal

---

## Test Coverage

All RAG modules have dedicated test suites:

| Module | Test File | Tests |
|--------|-----------|-------|
| Retrieval (BM25, hybrid, expansion) | `src/lib/rag/__tests__/retrieval.test.ts` | tokenize, bm25Score, expandQuery |
| Embeddings | `src/lib/rag/__tests__/embeddings.test.ts` | cosine similarity, serialization, Ollama calls |
| Chunker | `src/lib/rag/__tests__/chunker.test.ts` | markdown splitting, code blocks, overlap |
| Reranker | `src/lib/rag/__tests__/reranker.test.ts` | LLM scoring, fallback, truncation |
| Knowledge Graph | `src/lib/rag/__tests__/knowledge-graph.test.ts` | heuristic NER, extraction, traversal |
| Distributed RAG | `src/lib/rag/__tests__/distributed-retrieval.test.ts` | peer queries, dedup, penalties |
| Connector Registry | `src/integrations/__tests__/connector-registry.test.ts` | factory registration, lifecycle |
| GitHub Connector | `src/integrations/connectors/__tests__/github-connector.test.ts` | load, poll, auth |
| Local Files Connector | `src/integrations/connectors/__tests__/local-files-connector.test.ts` | load, poll, patterns |
| Google Drive Connector | `src/integrations/connectors/__tests__/google-drive-connector.test.ts` | load, export, pagination |
| Notion Connector | `src/integrations/connectors/__tests__/notion-connector.test.ts` | load, blocks-to-markdown |
| Document Worker | `src/execution/workers/__tests__/document-worker.test.ts` | queue processing, errors |
| Sync Scheduler | `src/scheduling/__tests__/connector-sync-scheduler.test.ts` | interval checking, sync lifecycle |
| Research (hybrid) | `src/execution/skills/__tests__/research.test.ts` | local + web integration |
