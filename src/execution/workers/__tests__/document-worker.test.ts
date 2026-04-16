import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DocumentWorker } from '../document-worker.js';
import { TypedEventBus } from '../../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../../tui/types.js';

// Mock the RAG imports
vi.mock('../../../lib/rag/chunker.js', () => ({
  chunkText: vi.fn((text: string) => [
    { content: text.slice(0, 100), tokenCount: 25, keywords: ['test'] },
  ]),
}));

vi.mock('../../../lib/rag/embeddings.js', () => ({
  generateEmbeddings: vi.fn(() => Promise.resolve([])),
  serializeEmbedding: vi.fn(() => 'serialized'),
}));

vi.mock('../../../lib/rag/retrieval.js', () => ({
  tokenize: vi.fn((text: string) => text.split(/\s+/)),
  retrieveKnowledgeChunks: vi.fn(),
}));

vi.mock('../../../orchestrator/tools/knowledge.js', () => ({
  extractTextLocal: vi.fn(() => Promise.resolve('Extracted document text content for testing.')),
  updateCorpusStats: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/**
 * Build a fresh chainable builder whose .then / .single resolve to `result`.
 * Each chaining method returns a new builder, so multiple calls to the same
 * table don't share state.
 */
function makeBuilder(result: { data: unknown; error: unknown } = { data: [], error: null }) {
  const self: Record<string, unknown> = {};
  for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'order', 'limit']) {
    self[method] = vi.fn(() => makeBuilder(result));
  }
  self.single = vi.fn(() => Promise.resolve(result));
  self.then = vi.fn((resolve: (v: unknown) => void) => {
    resolve(result);
    return Promise.resolve(result);
  });
  return self;
}

/** Create a mock DatabaseAdapter that dispatches per-table per-operation */
function createMockDb(overrides: Record<string, { data: unknown; error: unknown }> = {}) {
  const fromFn = vi.fn((table: string) => {
    const result = overrides[table] ?? { data: [], error: null };
    return makeBuilder(result);
  });
  return { from: fromFn };
}

describe('DocumentWorker', () => {
  let bus: TypedEventBus<RuntimeEvents>;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new TypedEventBus<RuntimeEvents>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips when no pending jobs exist', async () => {
    const db = createMockDb();
    const worker = new DocumentWorker(
      db as unknown as import('../../../db/adapter-types.js').DatabaseAdapter,
      bus,
      {},
    );

    worker.start();
    await worker.tick();
    worker.stop();

    // Should have queried the queue
    expect(db.from).toHaveBeenCalledWith('document_processing_queue');
    // Should NOT have queried documents table (no job to process)
    const docCalls = db.from.mock.calls.filter((c: string[]) => c[0] === 'agent_workforce_knowledge_documents');
    expect(docCalls.length).toBe(0);
  });

  it('picks up pending jobs and marks them as processing then done', async () => {
    const mockJob = {
      id: 'job-1',
      workspace_id: 'ws-1',
      document_id: 'doc-1',
      status: 'pending',
      payload: JSON.stringify({ source_type: 'url' }),
    };

    const mockDoc = {
      id: 'doc-1',
      title: 'Test Doc',
      filename: 'test.txt',
      file_type: '.txt',
      storage_path: 'url://example.com',
      source_type: 'url',
      compiled_text: 'Hello world, this is test document content.',
    };

    // We need the queue select to return a job, and the doc single to return a doc.
    // The simplest approach: override `from` to return appropriate results based on table + operation sequence.
    const fromCalls: Array<{ table: string; builder: ReturnType<typeof makeBuilder> }> = [];
    const db = {
      from: vi.fn((table: string) => {
        let result: { data: unknown; error: unknown };
        if (table === 'document_processing_queue' && fromCalls.filter(c => c.table === table).length === 0) {
          // First queue call: select pending jobs
          result = { data: [mockJob], error: null };
        } else if (table === 'agent_workforce_knowledge_documents' && fromCalls.filter(c => c.table === table).length === 0) {
          // First doc call: load document by id
          const b = makeBuilder({ data: mockDoc, error: null });
          fromCalls.push({ table, builder: b });
          return b;
        } else {
          result = { data: [], error: null };
        }
        const b = makeBuilder(result);
        fromCalls.push({ table, builder: b });
        return b;
      }),
    };

    const events: Array<{ documentId: string; status: string }> = [];
    bus.on('knowledge:processing', (payload) => events.push(payload));

    const worker = new DocumentWorker(
      db as unknown as import('../../../db/adapter-types.js').DatabaseAdapter,
      bus,
      {},
    );

    worker.start();
    await worker.tick();
    worker.stop();

    // Should have emitted started + completed events
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ documentId: 'doc-1', status: 'started' });
    expect(events[1]).toMatchObject({ documentId: 'doc-1', status: 'completed' });
  });

  it('handles errors gracefully and marks job as failed', async () => {
    const mockJob = {
      id: 'job-2',
      workspace_id: 'ws-1',
      document_id: 'doc-2',
      status: 'pending',
      payload: JSON.stringify({ source_type: 'url' }),
    };

    const mockDoc = {
      id: 'doc-2',
      title: 'Bad Doc',
      filename: 'bad.txt',
      file_type: '.txt',
      storage_path: 'url://example.com',
      source_type: 'url',
      compiled_text: null, // No text -> will fail
    };

    const fromCalls: Array<{ table: string }> = [];
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'document_processing_queue' && fromCalls.filter(c => c.table === table).length === 0) {
          fromCalls.push({ table });
          return makeBuilder({ data: [mockJob], error: null });
        }
        if (table === 'agent_workforce_knowledge_documents' && fromCalls.filter(c => c.table === table).length === 0) {
          fromCalls.push({ table });
          return makeBuilder({ data: mockDoc, error: null });
        }
        fromCalls.push({ table });
        return makeBuilder({ data: [], error: null });
      }),
    };

    const events: Array<{ documentId: string; status: string; error?: string }> = [];
    bus.on('knowledge:processing', (payload) => events.push(payload));

    const worker = new DocumentWorker(
      db as unknown as import('../../../db/adapter-types.js').DatabaseAdapter,
      bus,
      {},
    );

    worker.start();
    await worker.tick();
    worker.stop();

    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ documentId: 'doc-2', status: 'started' });
    expect(events[1]).toMatchObject({ documentId: 'doc-2', status: 'failed', error: 'No text could be extracted.' });
  });

  it('uses compiled_text as fallback for unknown source_type (arxiv, self-observation)', async () => {
    // Regression guard for the self-bench knowledge-ingest path: if a
    // new source_type lands in the KB that doesn't match upload/url/
    // connector, the worker must still chunk its compiled_text rather
    // than fail with "No text could be extracted."
    const mockJob = {
      id: 'job-arxiv',
      workspace_id: 'ws-1',
      document_id: 'doc-arxiv',
      status: 'pending',
      payload: JSON.stringify({ source_type: 'arxiv', url: 'https://arxiv.org/abs/2103.04529v3' }),
    };
    const mockDoc = {
      id: 'doc-arxiv',
      title: '[arxiv/cs.LG] Self-Supervised Online Reward Shaping',
      filename: 'arxiv-abc.txt',
      file_type: '.txt',
      storage_path: 'inline://arxiv/doc-arxiv',
      source_type: 'arxiv',
      compiled_text: 'Abstract: we introduce Self-Supervised Online Reward Shaping (SORS).',
    };

    const fromCalls: Array<{ table: string }> = [];
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'document_processing_queue' && fromCalls.filter(c => c.table === table).length === 0) {
          fromCalls.push({ table });
          return makeBuilder({ data: [mockJob], error: null });
        }
        if (table === 'agent_workforce_knowledge_documents' && fromCalls.filter(c => c.table === table).length === 0) {
          fromCalls.push({ table });
          return makeBuilder({ data: mockDoc, error: null });
        }
        fromCalls.push({ table });
        return makeBuilder({ data: [], error: null });
      }),
    };

    const events: Array<{ documentId: string; status: string }> = [];
    bus.on('knowledge:processing', (payload) => events.push(payload));

    const worker = new DocumentWorker(
      db as unknown as import('../../../db/adapter-types.js').DatabaseAdapter,
      bus,
      {},
    );

    worker.start();
    await worker.tick();
    worker.stop();

    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ documentId: 'doc-arxiv', status: 'started' });
    expect(events[1]).toMatchObject({ documentId: 'doc-arxiv', status: 'completed' });
  });

  it('emits failed event when document record not found', async () => {
    const mockJob = {
      id: 'job-3',
      workspace_id: 'ws-1',
      document_id: 'doc-3',
      status: 'pending',
      payload: JSON.stringify({ source_type: 'url' }),
    };

    const fromCalls: Array<{ table: string }> = [];
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'document_processing_queue' && fromCalls.filter(c => c.table === table).length === 0) {
          fromCalls.push({ table });
          return makeBuilder({ data: [mockJob], error: null });
        }
        // Document table returns null (not found)
        fromCalls.push({ table });
        return makeBuilder({ data: null, error: null });
      }),
    };

    const events: Array<{ documentId: string; status: string }> = [];
    bus.on('knowledge:processing', (payload) => events.push(payload));

    const worker = new DocumentWorker(
      db as unknown as import('../../../db/adapter-types.js').DatabaseAdapter,
      bus,
      {},
    );

    worker.start();
    await worker.tick();
    worker.stop();

    // Should emit failed event when document record not found
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ documentId: 'doc-3', status: 'failed' });
  });

  it('starts and stops the polling interval', () => {
    const db = createMockDb();
    const worker = new DocumentWorker(
      db as unknown as import('../../../db/adapter-types.js').DatabaseAdapter,
      bus,
      {},
    );

    worker.start();
    // Starting again should be a no-op
    worker.start();

    worker.stop();
    // Stopping again should be safe
    worker.stop();
  });
});
