import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cosineSimilarity, serializeEmbedding, deserializeEmbedding, generateEmbedding, generateEmbeddings } from '../embeddings.js';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it('returns 0 for different-length vectors', () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    const a = new Float32Array([]);
    const b = new Float32Array([]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 for zero vectors', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe('serializeEmbedding / deserializeEmbedding', () => {
  it('round-trips a Float32Array', () => {
    const original = new Float32Array([0.1, -0.5, 3.14, 0, -999.99]);
    const buffer = serializeEmbedding(original);
    const restored = deserializeEmbedding(buffer);
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('handles empty arrays', () => {
    const original = new Float32Array([]);
    const buffer = serializeEmbedding(original);
    const restored = deserializeEmbedding(buffer);
    expect(restored.length).toBe(0);
  });
});

describe('generateEmbedding', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns embedding on success', async () => {
    const mockEmbedding = [0.1, 0.2, 0.3];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [mockEmbedding] }),
    } as Response);

    const result = await generateEmbedding('test text', 'http://localhost:11434', 'nomic-embed-text');
    expect(result).not.toBeNull();
    expect(result!.model).toBe('nomic-embed-text');
    expect(result!.embedding.length).toBe(3);
    expect(result!.embedding[0]).toBeCloseTo(0.1);
  });

  it('returns null on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Connection refused'));

    const result = await generateEmbedding('test text', 'http://localhost:11434');
    expect(result).toBeNull();
  });

  it('returns null on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);

    const result = await generateEmbedding('test text', 'http://localhost:11434');
    expect(result).toBeNull();
  });

  it('returns null when embeddings array is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [] }),
    } as Response);

    const result = await generateEmbedding('test text', 'http://localhost:11434');
    expect(result).toBeNull();
  });
});

describe('generateEmbeddings', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns embeddings for multiple texts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2], [0.3, 0.4]] }),
    } as Response);

    const results = await generateEmbeddings(['text1', 'text2'], 'http://localhost:11434');
    expect(results.length).toBe(2);
    expect(results[0]).not.toBeNull();
    expect(results[1]).not.toBeNull();
  });

  it('returns nulls on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('fail'));

    const results = await generateEmbeddings(['a', 'b'], 'http://localhost:11434');
    expect(results).toEqual([null, null]);
  });

  it('returns empty array for empty input', async () => {
    const results = await generateEmbeddings([], 'http://localhost:11434');
    expect(results).toEqual([]);
  });
});
