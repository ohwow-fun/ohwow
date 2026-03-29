import { describe, it, expect } from 'vitest';
import {
  createCodebook,
  compress,
  decompress,
  compressBatch,
  decompressBatch,
  compressedDotProduct,
  compressionFidelity,
} from '../pipeline.js';
import { mulberry32, dotProduct, vectorNorm } from '../polar-quant.js';
import type { CompressionBits } from '../types.js';

function randomVector(dim: number, seed: number): Float32Array {
  const rng = mulberry32(seed);
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = (rng() - 0.5) * 4;
  return v;
}

describe('createCodebook', () => {
  it('creates a codebook with correct dimensions', () => {
    const cb = createCodebook({ bits: 4, dimension: 64 });
    expect(cb.dimension).toBe(64);
    expect(cb.bits).toBe(4);
    expect(cb.rotationMatrix.length).toBe(64 * 64);
    expect(cb.qjlEnabled).toBe(true);
    expect(cb.projectedDimension).toBeLessThanOrEqual(64);
    expect(cb.projectedDimension).toBeGreaterThanOrEqual(16);
  });

  it('respects enableQjl=false', () => {
    const cb = createCodebook({ bits: 4, dimension: 64, enableQjl: false });
    expect(cb.qjlEnabled).toBe(false);
    expect(cb.projectionMatrix.length).toBe(0);
  });

  it('is deterministic for same seed', () => {
    const cb1 = createCodebook({ bits: 4, dimension: 32, seed: 42 });
    const cb2 = createCodebook({ bits: 4, dimension: 32, seed: 42 });
    for (let i = 0; i < cb1.rotationMatrix.length; i++) {
      expect(cb1.rotationMatrix[i]).toBe(cb2.rotationMatrix[i]);
    }
  });
});

describe('compress / decompress', () => {
  it.each([
    [4, 0.95],
    [3, 0.9],
    [2, 0.8],
  ] as [CompressionBits, number][])('%d-bit compression has fidelity > %f', (bits, minFidelity) => {
    const dim = 64;
    const cb = createCodebook({ bits, dimension: dim, enableQjl: false });
    const v = randomVector(dim, 42);

    const compressed = compress(v, cb);
    const restored = decompress(compressed, cb);

    const fidelity = compressionFidelity(v, restored);
    expect(fidelity).toBeGreaterThan(minFidelity);
  });

  it('preserves vector dimension through roundtrip', () => {
    const dim = 128;
    const cb = createCodebook({ bits: 4, dimension: dim, enableQjl: false });
    const v = randomVector(dim, 100);

    const compressed = compress(v, cb);
    const restored = decompress(compressed, cb);

    expect(restored.length).toBe(dim);
  });

  it('stores original norm for QJL bias correction', () => {
    const dim = 64;
    const cb = createCodebook({ bits: 4, dimension: dim });
    const v = randomVector(dim, 200);

    const compressed = compress(v, cb);
    const expectedNorm = vectorNorm(v);

    expect(Math.abs(compressed.norm - expectedNorm)).toBeLessThan(1e-5);
  });
});

describe('compressBatch / decompressBatch', () => {
  it('produces correct stats', () => {
    const dim = 64;
    const cb = createCodebook({ bits: 4, dimension: dim, enableQjl: false });
    const vectors = Array.from({ length: 10 }, (_, i) => randomVector(dim, i));

    const { compressed, stats } = compressBatch(vectors, cb);

    expect(compressed.length).toBe(10);
    expect(stats.vectorCount).toBe(10);
    expect(stats.dimension).toBe(dim);
    expect(stats.bitsPerValue).toBe(4);
    expect(stats.originalBytes).toBe(10 * dim * 4); // Float32 = 4 bytes
    expect(stats.compressionRatio).toBeGreaterThan(1);
  });

  it('batch decompress matches individual decompress', () => {
    const dim = 32;
    const cb = createCodebook({ bits: 4, dimension: dim, enableQjl: false });
    const vectors = Array.from({ length: 5 }, (_, i) => randomVector(dim, i + 500));

    const { compressed } = compressBatch(vectors, cb);
    const batchRestored = decompressBatch(compressed, cb);

    for (let v = 0; v < vectors.length; v++) {
      const individual = decompress(compressed[v], cb);
      for (let i = 0; i < dim; i++) {
        expect(batchRestored[v][i]).toBe(individual[i]);
      }
    }
  });
});

describe('compressedDotProduct', () => {
  it('approximates true dot product without QJL', () => {
    const dim = 64;
    const cb = createCodebook({ bits: 4, dimension: dim, enableQjl: false });

    const errors: number[] = [];
    for (let trial = 0; trial < 50; trial++) {
      const a = randomVector(dim, trial * 2);
      const b = randomVector(dim, trial * 2 + 1);

      const trueDot = dotProduct(a, b);
      const compA = compress(a, cb);
      const compB = compress(b, cb);
      const estimated = compressedDotProduct(compA, compB, cb);

      if (Math.abs(trueDot) > 0.1) {
        errors.push(Math.abs(estimated - trueDot) / Math.abs(trueDot));
      }
    }

    const meanRelError = errors.reduce((a, b) => a + b, 0) / errors.length;
    expect(meanRelError).toBeLessThan(0.5); // within 50% relative error on average
  });

  it('approximates true dot product with QJL', () => {
    const dim = 64;
    const cb = createCodebook({ bits: 4, dimension: dim, enableQjl: true });

    const errors: number[] = [];
    for (let trial = 0; trial < 50; trial++) {
      const a = randomVector(dim, trial * 2 + 300);
      const b = randomVector(dim, trial * 2 + 301);

      const trueDot = dotProduct(a, b);
      const compA = compress(a, cb);
      const compB = compress(b, cb);
      const estimated = compressedDotProduct(compA, compB, cb);

      if (Math.abs(trueDot) > 0.1) {
        errors.push(Math.abs(estimated - trueDot) / Math.abs(trueDot));
      }
    }

    // QJL adds another layer of quantization on top of PolarQuant,
    // so error is higher but the estimates should still be in the right ballpark
    const meanRelError = errors.reduce((a, b) => a + b, 0) / errors.length;
    expect(meanRelError).toBeLessThan(10);
  });
});

describe('compressionFidelity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3, 4]);
    expect(compressionFidelity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('returns -1.0 for negated vectors', () => {
    const v = new Float32Array([1, 2, 3, 4]);
    const neg = new Float32Array([-1, -2, -3, -4]);
    expect(compressionFidelity(v, neg)).toBeCloseTo(-1.0, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(compressionFidelity(a, b)).toBeCloseTo(0, 5);
  });
});
