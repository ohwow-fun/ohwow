import { describe, it, expect } from 'vitest';
import { cosineSimilarity, serializeEmbedding, deserializeEmbedding } from '../embeddings.js';

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
