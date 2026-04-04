# Onyx Analysis: Lessons Learned & Enhancement Plan for ohwow

## Context

**Onyx** (formerly Danswer) is an enterprise AI assistant with world-class RAG capabilities: 62+ data source connectors, hybrid vector+keyword search via Vespa, 9 specialized Celery workers, reranking pipelines, knowledge graphs, multi-tenancy with RBAC/SSO, and broad LLM provider support (OpenAI, Anthropic, Google, Azure, Bedrock, Ollama, vLLM).

**ohwow** is a local-first AI cognitive operating system with a unique 7-layer philosophical architecture (Brain/Body/Work/Mesh/Soul/Symbiosis/BIOS), 150+ orchestrator tools, mesh networking, and MCP/A2A support. Its RAG is currently BM25-only with no embeddings, no reranking, and no connector ecosystem beyond Telegram.

This plan identifies the highest-impact enhancements ohwow can adopt from Onyx while respecting its local-first philosophy and unique strengths.

---

## PHASE 1: Quick Wins (Weeks 1-6)

### 1.1 IDF-Aware BM25 with Corpus Statistics
**Why**: Current BM25 (`src/lib/rag/retrieval.ts:72`) skips IDF entirely ("treat as 1"), so common words score the same as rare discriminative terms.

**Files**:
- `src/lib/rag/retrieval.ts` — modify `bm25Score()` to accept doc-frequency map, compute proper IDF
- `src/db/migrations/` — new migration: `rag_corpus_stats` table `(workspace_id, term, doc_frequency)`
- `src/orchestrator/tools/knowledge.ts` — accumulate term frequencies at ingest time in `chunkTextLocal()` (line ~446)

**Priority**: HIGH | **Effort**: Small

---

### 1.2 Connector Interface Abstraction
**Why**: ohwow has `MessagingChannel` (`src/integrations/channel-types.ts:27-39`) for messaging but no equivalent for data source connectors. Onyx's `LoadConnector`/`PollConnector` pattern is proven. This interface is the foundation for the entire connector ecosystem.

**Files**:
- New: `src/integrations/connector-types.ts` — `DataSourceConnector` interface
- New: `src/integrations/connector-registry.ts` — registry (mirrors `ChannelRegistry` pattern)
- `src/orchestrator/tools/knowledge.ts` — add `syncConnector()` handler

**Interface design**:
```typescript
interface DataSourceConnector {
  readonly type: string;           // 'github', 'google-drive', etc.
  readonly name: string;
  load(): AsyncGenerator<ConnectorDocument>;
  poll?(since: Date): AsyncGenerator<ConnectorDocument>;
  testConnection(): Promise<boolean>;
}
```

**Priority**: HIGH | **Effort**: Small

---

### 1.3 Hybrid Search: Local Embedding Support
**Why**: This is the single highest-impact enhancement. BM25 fails on semantic similarity. Ollama ships embedding models (`nomic-embed-text`) that work fully offline.

**Files**:
- New: `src/lib/rag/embeddings.ts` — call Ollama `/api/embeddings`, cosine similarity
- `src/lib/rag/retrieval.ts` — combine: `finalScore = alpha * bm25 + (1-alpha) * cosine`
- `src/db/migrations/` — add `embedding BLOB` column to `agent_workforce_knowledge_chunks`
- `src/orchestrator/tools/knowledge.ts` — generate embeddings during `chunkTextLocal()`
- `src/config.ts` — add `embeddingModel` config (default: `nomic-embed-text`)

**Graceful fallback**: If Ollama unavailable or model not pulled, fall back to BM25-only.

**Priority**: CRITICAL | **Effort**: Medium

---

### 1.4 Query Expansion
**Why**: Single-query retrieval misses documents using different terminology. Simple LLM-based rephrasings dramatically improve recall.

**Files**:
- `src/lib/rag/retrieval.ts` — add `expandQuery()` before scoring loop (line ~105)
- Uses existing `src/execution/model-router.ts` for small Ollama calls

**Approach**: Before scoring, ask Ollama for 2-3 alternative phrasings, union all tokens. Fallback: use original query if Ollama unavailable.

**Priority**: MEDIUM | **Effort**: Small

---

## PHASE 2: Structural Improvements (Weeks 7-14)

### 2.1 Background Document Processing Worker
**Why**: `uploadKnowledge()` (knowledge.ts:119-177) processes documents synchronously, blocking the orchestrator. Required before connectors can scale.

**Files**:
- New: `src/execution/workers/document-worker.ts` — background processing loop
- `src/orchestrator/tools/knowledge.ts` — enqueue work, return immediately
- `src/db/migrations/` — `document_processing_queue` table
- `src/daemon/start.ts` — start worker alongside other services

**Approach**: Register as a `DigitalNervousSystem` monitor (`src/body/digital-nervous-system.ts`), emit events via `TypedEventBus` for TUI progress.

**Priority**: HIGH | **Effort**: Medium

---

### 2.2 Smarter Chunking Strategy
**Why**: Current chunking (knowledge.ts:446-493) is paragraph-based with fixed 4000-char target, no overlap, no structure awareness.

**Files**:
- New: `src/lib/rag/chunker.ts` — extract and enhance chunking logic
- `src/orchestrator/tools/knowledge.ts` — replace inline `chunkTextLocal()`

**Improvements**: Markdown-aware (split on headers, keep header as prefix), code-block-aware (never split mid-block), configurable 200-char overlap, parent-child chunk references.

**Priority**: MEDIUM | **Effort**: Medium

---

### 2.3 First-Party Connectors: GitHub + Local Files Watcher
**Why**: Most natural connectors for a local-first developer tool.

**Files**:
- New: `src/integrations/connectors/github-connector.ts`
- New: `src/integrations/connectors/local-files-connector.ts`
- `src/scheduling/local-scheduler.ts` — register periodic connector sync (30min default, like Onyx)

**Priority**: HIGH | **Effort**: Medium

---

### 2.4 Reranking Pipeline
**Why**: Hybrid search benefits from a reranking step. Use local Ollama for cross-encoder-style scoring.

**Files**:
- New: `src/lib/rag/reranker.ts`
- `src/lib/rag/retrieval.ts` — add reranking between scoring (line ~166) and budget selection (line ~199)

**Approach**: Retrieve top-20 candidates, rerank via Ollama prompt ("Rate relevance 0-10"), re-sort, then apply token budget. Opt-in via `rerankerEnabled` config.

**Priority**: MEDIUM | **Effort**: Medium

---

### 2.5 OpenAI-Compatible LLM Provider
**Why**: Covers vLLM, Together, Groq, any local server with one adapter. Ollama already uses this format — just make base URL/auth configurable.

**Files**:
- New: `src/execution/providers/openai-compatible-provider.ts`
- `src/execution/model-router.ts` — register provider
- `src/config.ts` — add `openaiCompatibleUrl`, `openaiCompatibleApiKey`

**Priority**: MEDIUM | **Effort**: Small

---

## PHASE 3: Long-Term (Weeks 15+)

### 3.1 Knowledge Graph Generation
**Why**: Aligns with Brain layer's `GlobalWorkspace` (consciousness bus). Enables relationship understanding across documents.

**Files**:
- New: `src/lib/rag/knowledge-graph.ts`
- `src/db/migrations/` — `knowledge_graph_nodes`, `knowledge_graph_edges` tables
- `src/brain/global-workspace.ts` — integrate graph queries into consciousness bus

**Approach**: Extract (subject, predicate, object) triples via LLM at ingest, store in SQLite adjacency model, traverse 1-2 hops at query time.

**Priority**: LOW | **Effort**: Large

---

### 3.2 Multi-Step Research with Knowledge Base
**Why**: Existing `deepResearch` (`src/execution/skills/research.ts`) uses web search only. Should combine local knowledge + web, with iterative gap-filling.

**Files**:
- `src/execution/skills/research.ts` — add knowledge base retrieval step
- `src/orchestrator/tools/research.ts` — update tool wrapper

**Priority**: MEDIUM | **Effort**: Medium

---

### 3.3 Connector Ecosystem Expansion
**Why**: With interface and worker in place, expand to Google Drive, Notion, Slack, Confluence, IMAP email.

Each connector follows the pattern from 1.2 and lives in `src/integrations/connectors/`.

**Priority**: LOW-MEDIUM | **Effort**: Medium per connector

---

### 3.4 Mesh-Distributed RAG
**Why**: ohwow's unique mesh layer (`src/peers/`, `src/mesh/`) enables something Onyx cannot: distributed knowledge retrieval across peers.

**Files**:
- `src/mesh/mesh-router.ts` — add RAG query routing
- `src/peers/local-router.ts` — add RAG search endpoint
- `src/lib/rag/retrieval.ts` — add `retrieveFromMesh()`

**Priority**: LOW | **Effort**: Large

---

## Cross-Cutting: Test Coverage

Every enhancement ships with tests. Key test files to create:
- `src/lib/rag/__tests__/retrieval.test.ts`
- `src/lib/rag/__tests__/embeddings.test.ts`
- `src/lib/rag/__tests__/chunker.test.ts`
- `src/lib/rag/__tests__/reranker.test.ts`
- `src/integrations/__tests__/connector-registry.test.ts`

Incrementally raise thresholds in `vitest.config.ts` (currently 15%).

---

## Design Principles

1. **Every enhancement works offline** — embeddings via Ollama, chunking is pure local, query expansion falls back gracefully
2. **Graceful degradation** — if Ollama is down, BM25 still works; if embeddings missing for a chunk, skip cosine for that chunk
3. **Respect the philosophical architecture** — RAG integrates through Brain's `GlobalWorkspace`, connectors flow through Body's `DigitalNervousSystem`
4. **Reuse existing patterns** — `ChannelRegistry` for connector registry, `DigitalNervousSystem` monitors for background workers, `TypedEventBus` for progress
5. **No heavy dependencies** — no Vespa, Redis, or Celery. SQLite + Ollama + Node.js workers keep the footprint minimal

---

## Implementation Sequence

```
Week 1-2:   1.1 (IDF BM25) + 1.2 (Connector interface) + Tests
Week 3-4:   1.3 (Embeddings / hybrid search)
Week 5-6:   1.4 (Query expansion) + 2.2 (Smart chunking)
Week 7-10:  2.1 (Background worker) + 2.3 (GitHub + local-files connectors)
Week 11-14: 2.4 (Reranking) + 2.5 (OpenAI-compatible provider)
Week 15-18: 3.2 (Multi-step research) + 3.3 (More connectors)
Week 19+:   3.1 (Knowledge graph) + 3.4 (Mesh-distributed RAG)
```

## Verification

- `npm run typecheck && npm test` after each enhancement
- Manual testing: upload a document, query it with semantic terms (not keyword matches), verify retrieval improves with embeddings vs BM25-only
- Connector testing: configure GitHub connector, sync a repo, query against synced content
- Performance: measure retrieval latency before/after reranking (target <2s for local Ollama)
