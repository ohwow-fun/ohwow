/**
 * retrieveKnowledgeChunks — hybrid-scoring path.
 *
 * Locks two contracts the daemon's knowledge search depends on:
 *   1. The query string is projected through getSharedEmbedder().embed()
 *      with isQuery=true and a non-empty Qwen3 instruction, so queries
 *      land in the same vector space as stored chunk embeddings.
 *   2. With bm25Weight=0 (pure cosine), result order matches cosine
 *      similarity between query and stored chunk vectors — not keyword
 *      overlap.
 *
 * Uses a stubbed in-memory DatabaseAdapter and a stubbed embedder so the
 * test runs in <200ms and needs no ONNX weights.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retrieveKnowledgeChunks } from '../retrieval.js';
import { serializeEmbedding } from '../embeddings.js';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Singleton mock — captured so each test can inspect the call.
const embedCalls: Array<{ texts: string[]; opts: unknown }> = [];
let queryVector = new Float32Array([1, 0, 0, 0]);

vi.mock('../../../embeddings/singleton.js', () => ({
  getSharedEmbedder: vi.fn(() => ({
    modelId: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    dim: 4,
    ready: vi.fn().mockResolvedValue(undefined),
    embed: vi.fn(async (texts: string[], opts: unknown) => {
      embedCalls.push({ texts, opts });
      return [queryVector];
    }),
  })),
}));

// Knowledge-graph + reranker calls are orthogonal to hybrid scoring; stub
// them so the test doesn't drag in Ollama / fetch mocks.
vi.mock('../knowledge-graph.js', () => ({
  getRelatedChunkIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../reranker.js', () => ({
  rerankWithLLM: vi.fn().mockResolvedValue([]),
}));

/**
 * Builds a chainable adapter whose responses are keyed by table. Each
 * chained method returns the same object so `.eq().eq().in().or()`
 * terminates with the stub `then`.
 */
function makeDb(tables: Record<string, unknown[]>) {
  function build(table: string) {
    const data = tables[table] ?? [];
    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      neq: vi.fn(() => chain),
      in: vi.fn(() => chain),
      is: vi.fn(() => chain),
      or: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      single: vi.fn(() => Promise.resolve({ data: data[0] ?? null, error: null })),
      maybeSingle: vi.fn(() =>
        Promise.resolve({ data: data[0] ?? null, error: null }),
      ),
      then: (resolve: (v: unknown) => void) => {
        const r = { data, error: null, count: data.length };
        resolve(r);
        return Promise.resolve(r);
      },
    };
    return chain;
  }
  return {
    from: vi.fn((table: string) => build(table)),
    rpc: vi.fn(),
  };
}

describe('retrieveKnowledgeChunks (hybrid scoring)', () => {
  beforeEach(() => {
    embedCalls.length = 0;
    queryVector = new Float32Array([1, 0, 0, 0]);
  });

  it('calls the embedder with isQuery=true and a non-empty Qwen3 instruction', async () => {
    const chunkEmbedding = serializeEmbedding(new Float32Array([1, 0, 0, 0]));
    const db = makeDb({
      agent_workforce_knowledge_documents: [
        {
          id: 'doc-1',
          title: 'Doc',
          processing_status: 'ready',
          is_active: 1,
          agent_id: null,
        },
      ],
      agent_workforce_knowledge_agent_config: [],
      agent_workforce_knowledge_chunks: [
        {
          id: 'chunk-1',
          document_id: 'doc-1',
          content: 'totally unrelated lexical surface',
          keywords: null,
          token_count: 10,
          embedding: chunkEmbedding,
        },
      ],
      rag_corpus_stats: [],
    });

    await retrieveKnowledgeChunks({
      db: db as never,
      workspaceId: 'ws-1',
      agentId: '__orchestrator__',
      query: 'how do I add a knowledge URL',
    });

    expect(embedCalls).toHaveLength(1);
    const call = embedCalls[0];
    expect(call.texts).toEqual(['how do I add a knowledge URL']);
    const opts = call.opts as { isQuery?: boolean; instruction?: string };
    expect(opts.isQuery).toBe(true);
    expect(typeof opts.instruction).toBe('string');
    expect((opts.instruction as string).length).toBeGreaterThan(0);
    // Sanity: the instruction should mention retrieval/query context so
    // swapping to a different asymmetric model requires a conscious update.
    expect(opts.instruction as string).toMatch(/search|query|retriev/i);
  });

  it('ranks chunks by cosine similarity to the query vector when bm25Weight=0', async () => {
    // Query vector points at e0. Two chunks, one aligned with e0 (cosine 1)
    // and one aligned with e1 (cosine 0). Keyword overlap inverted so BM25
    // alone would rank them backwards — the cosine path has to win.
    queryVector = new Float32Array([1, 0, 0, 0]);
    const alignedChunk = {
      id: 'aligned',
      document_id: 'doc-1',
      content: 'completely different words here',
      keywords: null,
      token_count: 10,
      embedding: serializeEmbedding(new Float32Array([1, 0, 0, 0])),
    };
    const misalignedChunk = {
      id: 'misaligned',
      document_id: 'doc-1',
      content: 'add knowledge URL knowledge URL knowledge URL',
      keywords: null,
      token_count: 10,
      embedding: serializeEmbedding(new Float32Array([0, 1, 0, 0])),
    };

    const db = makeDb({
      agent_workforce_knowledge_documents: [
        {
          id: 'doc-1',
          title: 'Doc',
          processing_status: 'ready',
          is_active: 1,
          agent_id: null,
        },
      ],
      agent_workforce_knowledge_agent_config: [],
      agent_workforce_knowledge_chunks: [misalignedChunk, alignedChunk],
      rag_corpus_stats: [],
    });

    const results = await retrieveKnowledgeChunks({
      db: db as never,
      workspaceId: 'ws-1',
      agentId: '__orchestrator__',
      query: 'add knowledge URL',
      bm25Weight: 0, // pure cosine
      minScore: 0,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('aligned');
    // Cosine 1.0 between query and aligned chunk.
    expect(results[0].score).toBeCloseTo(1.0, 5);
  });

  it('uses the default bm25Weight=0.2 (cosine-dominant) when unspecified', async () => {
    queryVector = new Float32Array([1, 0, 0, 0]);
    const cosineWinner = {
      id: 'cosine-winner',
      document_id: 'doc-1',
      content: 'no keyword overlap at all',
      keywords: null,
      token_count: 10,
      embedding: serializeEmbedding(new Float32Array([1, 0, 0, 0])),
    };
    const bm25Winner = {
      id: 'bm25-winner',
      document_id: 'doc-1',
      content: 'elephant elephant elephant elephant',
      keywords: null,
      token_count: 10,
      embedding: serializeEmbedding(new Float32Array([0, 1, 0, 0])),
    };
    const db = makeDb({
      agent_workforce_knowledge_documents: [
        {
          id: 'doc-1',
          title: 'Doc',
          processing_status: 'ready',
          is_active: 1,
          agent_id: null,
        },
      ],
      agent_workforce_knowledge_agent_config: [],
      agent_workforce_knowledge_chunks: [bm25Winner, cosineWinner],
      rag_corpus_stats: [],
    });

    // Query matches BM25-winner lexically but cosine-winner semantically.
    const results = await retrieveKnowledgeChunks({
      db: db as never,
      workspaceId: 'ws-1',
      agentId: '__orchestrator__',
      query: 'elephant',
      // Leave bm25Weight unspecified — exercises the 0.2 default.
      minScore: 0,
    });

    // 0.2 * normalized-bm25 + 0.8 * cosine. Cosine-winner: 0 + 0.8 = 0.8.
    // BM25-winner: 0.2 * 1 + 0.8 * 0 = 0.2. Cosine must win at the default.
    expect(results[0].id).toBe('cosine-winner');
  });
});
