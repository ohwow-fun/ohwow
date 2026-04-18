/**
 * runEmbeddingBackfill — unit tests.
 *
 * Freezes the contract the daemon boot path relies on:
 *   1. Idempotent: a pass over a table whose rows are all embedded by
 *      the current model writes nothing and exits quickly.
 *   2. Batching: rows beyond `batchSize` are processed in multiple
 *      forward passes, not one giant one.
 *   3. Model drift: rows tagged with a different embedding_model get
 *      re-embedded on the next pass (protects us when we bump HF repos).
 *   4. Non-fatal: the worker never throws — page-level errors abort
 *      the scan; batch-level errors skip the batch and continue.
 *
 * Mocks the DatabaseAdapter with a chainable builder that buffers
 * update() calls per row so we can assert the exact writeback set.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import { runEmbeddingBackfill } from '../backfill.js';
import type { Embedder } from '../model.js';

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MODEL_ID = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';
const OLD_MODEL = 'nomic-embed-text:latest';

interface ChunkFixture {
  id: string;
  content: string;
  embedding_model: string | null;
  created_at: string;
}

function fakeLogger(): Logger {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  // pino's logger also exposes child/level, but the backfill only calls the
  // four severity methods.
  return l as unknown as Logger;
}

function fakeEmbedder(overrides: Partial<Embedder> = {}): Embedder {
  const embed = vi.fn(async (texts: string[]) =>
    texts.map(() => {
      const v = new Float32Array(4);
      v[0] = 1;
      return v;
    }),
  );
  return {
    modelId: MODEL_ID,
    dim: 4,
    ready: vi.fn().mockResolvedValue(undefined),
    embed,
    ...overrides,
  } as Embedder;
}

/**
 * In-memory stand-in for the adapter chain. The backfill only exercises:
 *   from(t).select(...).order(...).limit(N)
 *   from(t).update(patch).eq('id', x)
 * so we keep this mock tightly scoped to those shapes.
 */
function makeDb(rows: ChunkFixture[]) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let pagesServed = 0;

  const selectChain = () => {
    let limitValue = Infinity;
    const chain = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn((n: number) => {
        limitValue = n;
        return chain;
      }),
      then: (resolve: (v: unknown) => void) => {
        pagesServed++;
        // Serve the page from a live snapshot so updates applied between
        // pages are visible on the next scan. In real life the DB does
        // this for us; here we re-read the fixture array by id.
        const refreshed = rows.map(
          (r) => ({ ...r, embedding_model: r.embedding_model } as ChunkFixture),
        );
        const page = refreshed.slice(0, Math.min(limitValue, refreshed.length));
        resolve({ data: page, error: null });
        return Promise.resolve({ data: page, error: null });
      },
    };
    return chain;
  };

  const updateChain = (patch: Record<string, unknown>) => {
    const chain = {
      eq: vi.fn((col: string, value: string) => {
        if (col !== 'id') throw new Error(`unexpected update filter: ${col}`);
        updates.push({ id: value, patch });
        // Apply in-place so subsequent pages see the new embedding_model.
        const row = rows.find((r) => r.id === value);
        if (row && typeof patch.embedding_model === 'string') {
          row.embedding_model = patch.embedding_model;
        }
        return Promise.resolve({ data: null, error: null });
      }),
      then: (resolve: (v: unknown) => void) => {
        resolve({ data: null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
    };
    return chain;
  };

  const adapter = {
    from: vi.fn((_table: string) => ({
      select: (..._args: unknown[]) => selectChain(),
      update: (patch: Record<string, unknown>) => updateChain(patch),
    })),
    rpc: vi.fn(),
    __updates: updates,
    __pages: () => pagesServed,
  };

  return adapter as unknown as ReturnType<typeof vi.fn> &
    { from: typeof adapter.from; __updates: typeof updates; __pages: () => number };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runEmbeddingBackfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('awaits embedder.ready() before scanning', async () => {
    const readyOrder: string[] = [];
    const embedder = fakeEmbedder({
      ready: vi.fn(async () => {
        readyOrder.push('ready');
      }),
    });
    const rows: ChunkFixture[] = [
      { id: 'c1', content: 'hello', embedding_model: null, created_at: '2026-01-01' },
    ];
    const db = makeDb(rows);
    // Stamp the first adapter call so we can see the ordering.
    const originalFrom = db.from;
    db.from = vi.fn((...args: unknown[]) => {
      readyOrder.push('from');
      return originalFrom(...(args as [string]));
    }) as unknown as typeof db.from;

    await runEmbeddingBackfill({ db: db as never, embedder, logger: fakeLogger() });

    expect(readyOrder[0]).toBe('ready');
    expect(readyOrder).toContain('from');
  });

  it('is idempotent — does nothing when every row already matches the current model', async () => {
    const embedder = fakeEmbedder();
    const rows: ChunkFixture[] = [
      { id: 'c1', content: 'a', embedding_model: MODEL_ID, created_at: '2026-01-01' },
      { id: 'c2', content: 'b', embedding_model: MODEL_ID, created_at: '2026-01-02' },
    ];
    const db = makeDb(rows);

    await runEmbeddingBackfill({ db: db as never, embedder, logger: fakeLogger() });

    expect(embedder.embed).not.toHaveBeenCalled();
    expect(db.__updates).toHaveLength(0);
  });

  it('embeds rows missing the current model and stamps embedding_model + timestamp', async () => {
    const embedder = fakeEmbedder();
    const rows: ChunkFixture[] = [
      { id: 'c1', content: 'hello', embedding_model: null, created_at: '2026-01-01' },
      { id: 'c2', content: 'world', embedding_model: null, created_at: '2026-01-02' },
    ];
    const db = makeDb(rows);

    await runEmbeddingBackfill({ db: db as never, embedder, logger: fakeLogger() });

    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(embedder.embed).toHaveBeenCalledWith(['hello', 'world']);
    expect(db.__updates).toHaveLength(2);
    for (const u of db.__updates) {
      expect(u.patch.embedding_model).toBe(MODEL_ID);
      expect(u.patch).toHaveProperty('embedding');
      expect(typeof u.patch.embedding_updated_at).toBe('string');
      // ISO 8601 check — constructable as a Date.
      expect(() => new Date(u.patch.embedding_updated_at as string)).not.toThrow();
    }
    expect(db.__updates.map((u) => u.id).sort()).toEqual(['c1', 'c2']);
  });

  it('re-embeds rows tagged with a stale embedding_model', async () => {
    const embedder = fakeEmbedder();
    const rows: ChunkFixture[] = [
      { id: 'stale', content: 'old', embedding_model: OLD_MODEL, created_at: '2026-01-01' },
      { id: 'fresh', content: 'new', embedding_model: MODEL_ID, created_at: '2026-01-02' },
    ];
    const db = makeDb(rows);

    await runEmbeddingBackfill({ db: db as never, embedder, logger: fakeLogger() });

    // Only the stale row should be embedded.
    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(embedder.embed).toHaveBeenCalledWith(['old']);
    expect(db.__updates).toHaveLength(1);
    expect(db.__updates[0].id).toBe('stale');
    expect(db.__updates[0].patch.embedding_model).toBe(MODEL_ID);
  });

  it('splits work across multiple forward passes when rows exceed batchSize', async () => {
    const embedder = fakeEmbedder();
    const rows: ChunkFixture[] = Array.from({ length: 7 }, (_, i) => ({
      id: `c${i}`,
      content: `row-${i}`,
      embedding_model: null,
      created_at: `2026-01-${String(i + 1).padStart(2, '0')}`,
    }));
    const db = makeDb(rows);

    await runEmbeddingBackfill({
      db: db as never,
      embedder,
      batchSize: 3, // forces 3 + 3 + 1
      logger: fakeLogger(),
    });

    expect(embedder.embed).toHaveBeenCalledTimes(3);
    expect((embedder.embed as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(3);
    expect((embedder.embed as ReturnType<typeof vi.fn>).mock.calls[1][0]).toHaveLength(3);
    expect((embedder.embed as ReturnType<typeof vi.fn>).mock.calls[2][0]).toHaveLength(1);
    expect(db.__updates).toHaveLength(7);
  });

  it('continues past a failed batch and does not crash the daemon', async () => {
    // First batch throws, second succeeds. Both should be attempted.
    let callCount = 0;
    const embedder = fakeEmbedder({
      embed: vi.fn(async (texts: string[]) => {
        callCount++;
        if (callCount === 1) throw new Error('simulated ONNX crash');
        return texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4]));
      }),
    });
    const rows: ChunkFixture[] = [
      { id: 'c1', content: 'batch1-a', embedding_model: null, created_at: '2026-01-01' },
      { id: 'c2', content: 'batch1-b', embedding_model: null, created_at: '2026-01-02' },
      { id: 'c3', content: 'batch2-a', embedding_model: null, created_at: '2026-01-03' },
      { id: 'c4', content: 'batch2-b', embedding_model: null, created_at: '2026-01-04' },
    ];
    const db = makeDb(rows);

    await expect(
      runEmbeddingBackfill({
        db: db as never,
        embedder,
        batchSize: 2,
        logger: fakeLogger(),
      }),
    ).resolves.toBeUndefined();

    // Only the successful batch wrote back.
    expect(db.__updates.map((u) => u.id).sort()).toEqual(['c3', 'c4']);
  });

  it('aborts cleanly when the adapter returns an error on the page query', async () => {
    const embedder = fakeEmbedder();
    // Adapter whose select chain resolves with an error — mirrors a dropped
    // connection or a missing migration.
    const errorDb = {
      from: vi.fn(() => ({
        select: () => ({
          order: () => ({
            limit: () => ({
              then: (resolve: (v: unknown) => void) => {
                const r = { data: null, error: { message: 'table missing' } };
                resolve(r);
                return Promise.resolve(r);
              },
            }),
          }),
        }),
      })),
      rpc: vi.fn(),
    };

    await expect(
      runEmbeddingBackfill({
        db: errorDb as never,
        embedder,
        logger: fakeLogger(),
      }),
    ).resolves.toBeUndefined();

    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it('skips rows whose embed vector comes back undefined', async () => {
    // Embedder returns a short array so the second row maps to undefined.
    const embedder = fakeEmbedder({
      embed: vi.fn(async (texts: string[]) => {
        // Intentionally return only one vector for two inputs.
        return texts.slice(0, 1).map(() => new Float32Array([1, 0, 0, 0]));
      }),
    });
    const rows: ChunkFixture[] = [
      { id: 'a', content: 'first', embedding_model: null, created_at: '2026-01-01' },
      { id: 'b', content: 'second', embedding_model: null, created_at: '2026-01-02' },
    ];
    const db = makeDb(rows);

    await runEmbeddingBackfill({
      db: db as never,
      embedder,
      batchSize: 5,
      logger: fakeLogger(),
    });

    // Only the first row got a writeback; the orphaned input was counted as
    // failed, not applied as an empty update.
    expect(db.__updates).toHaveLength(1);
    expect(db.__updates[0].id).toBe('a');
  });
});
