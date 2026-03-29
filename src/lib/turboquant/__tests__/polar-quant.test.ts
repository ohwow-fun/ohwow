import { describe, it, expect } from 'vitest';
import {
  mulberry32,
  boxMullerGaussian,
  generateOrthogonalMatrix,
  rotateVector,
  inverseRotateVector,
  uniformQuantize,
  uniformDequantize,
  packBits,
  unpackBits,
  vectorNorm,
  dotProduct,
} from '../polar-quant.js';
import type { CompressionBits } from '../types.js';

describe('mulberry32', () => {
  it('produces deterministic output for the same seed', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it('produces values in [0, 1)', () => {
    const rng = mulberry32(12345);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('produces different sequences for different seeds', () => {
    const rng1 = mulberry32(1);
    const rng2 = mulberry32(2);
    let same = 0;
    for (let i = 0; i < 100; i++) {
      if (rng1() === rng2()) same++;
    }
    expect(same).toBeLessThan(5);
  });
});

describe('boxMullerGaussian', () => {
  it('produces approximately normal distributed values', () => {
    const rng = mulberry32(42);
    const samples: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const [g1, g2] = boxMullerGaussian(rng);
      samples.push(g1, g2);
    }

    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;

    // Standard normal: mean ~0, variance ~1
    expect(Math.abs(mean)).toBeLessThan(0.1);
    expect(Math.abs(variance - 1)).toBeLessThan(0.15);
  });
});

describe('generateOrthogonalMatrix', () => {
  it('produces a matrix where Q^T * Q is approximately identity', () => {
    const n = 32;
    const Q = generateOrthogonalMatrix(n, 42);

    // Compute Q^T * Q
    const QtQ = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let k = 0; k < n; k++) {
          sum += Q[k * n + i] * Q[k * n + j]; // Q^T[i,k] * Q[k,j]
        }
        QtQ[i * n + j] = sum;
      }
    }

    // Check Frobenius norm of (Q^T Q - I) is small
    let frobNorm = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const expected = i === j ? 1.0 : 0.0;
        const diff = QtQ[i * n + j] - expected;
        frobNorm += diff * diff;
      }
    }
    frobNorm = Math.sqrt(frobNorm);
    expect(frobNorm).toBeLessThan(1e-3);
  });

  it('is deterministic for the same seed', () => {
    const Q1 = generateOrthogonalMatrix(16, 99);
    const Q2 = generateOrthogonalMatrix(16, 99);
    for (let i = 0; i < Q1.length; i++) {
      expect(Q1[i]).toBe(Q2[i]);
    }
  });

  it('produces different matrices for different seeds', () => {
    const Q1 = generateOrthogonalMatrix(16, 1);
    const Q2 = generateOrthogonalMatrix(16, 2);
    let same = 0;
    for (let i = 0; i < Q1.length; i++) {
      if (Q1[i] === Q2[i]) same++;
    }
    expect(same).toBeLessThan(Q1.length * 0.1);
  });
});

describe('rotateVector / inverseRotateVector', () => {
  it('recovers the original vector after rotate + inverse', () => {
    const n = 64;
    const Q = generateOrthogonalMatrix(n, 42);
    const rng = mulberry32(123);
    const original = new Float32Array(n);
    for (let i = 0; i < n; i++) original[i] = (rng() - 0.5) * 10;

    const rotated = rotateVector(original, Q, n);
    const recovered = inverseRotateVector(rotated, Q, n);

    for (let i = 0; i < n; i++) {
      expect(Math.abs(recovered[i] - original[i])).toBeLessThan(1e-4);
    }
  });

  it('preserves vector norm after rotation', () => {
    const n = 32;
    const Q = generateOrthogonalMatrix(n, 42);
    const rng = mulberry32(456);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = rng() * 5;

    const rotated = rotateVector(v, Q, n);
    const origNorm = vectorNorm(v);
    const rotNorm = vectorNorm(rotated);

    expect(Math.abs(origNorm - rotNorm) / origNorm).toBeLessThan(1e-4);
  });

  it('makes dimension values more uniform after rotation', () => {
    const n = 64;
    const Q = generateOrthogonalMatrix(n, 42);

    // Create a vector with outlier dimensions (common in KV caches)
    const v = new Float32Array(n);
    const rng = mulberry32(789);
    for (let i = 0; i < n; i++) v[i] = rng() * 0.1;
    v[0] = 50; // outlier
    v[1] = -30; // outlier

    const rotated = rotateVector(v, Q, n);

    // Check that max/min ratio is smaller after rotation
    const origMax = Math.max(...v);
    const origMin = Math.min(...v);
    const origRange = origMax - origMin;

    const rotMax = Math.max(...rotated);
    const rotMin = Math.min(...rotated);
    const rotRange = rotMax - rotMin;

    expect(rotRange).toBeLessThan(origRange);
  });
});

describe('packBits / unpackBits', () => {
  it.each([2, 3, 4] as CompressionBits[])('roundtrips correctly at %d bits', (bits) => {
    const maxVal = (1 << bits) - 1;
    const values = new Uint8Array(100);
    for (let i = 0; i < values.length; i++) values[i] = i % (maxVal + 1);

    const packed = packBits(values, bits);
    const unpacked = unpackBits(packed, bits, values.length);

    for (let i = 0; i < values.length; i++) {
      expect(unpacked[i]).toBe(values[i]);
    }
  });

  it('produces compact output', () => {
    const values = new Uint8Array(100);
    for (let i = 0; i < 100; i++) values[i] = i % 4;

    const packed2 = packBits(values, 2);
    const packed4 = packBits(values, 4);

    expect(packed2.length).toBe(Math.ceil(100 * 2 / 8));
    expect(packed4.length).toBe(Math.ceil(100 * 4 / 8));
  });
});

describe('uniformQuantize / uniformDequantize', () => {
  it.each([2, 3, 4] as CompressionBits[])('roundtrip works at %d bits', (bits) => {
    const n = 64;
    const Q = generateOrthogonalMatrix(n, 42);
    const rng = mulberry32(100);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = (rng() - 0.5) * 6;
    const rotated = rotateVector(v, Q, n);

    const { quantized, scale, zeroPoint } = uniformQuantize(rotated, bits);
    const restored = uniformDequantize(quantized, scale, zeroPoint, bits, n);

    let mse = 0;
    for (let i = 0; i < n; i++) {
      mse += (restored[i] - rotated[i]) ** 2;
    }
    mse /= n;
    // Should produce finite, reasonable error
    expect(mse).toBeGreaterThanOrEqual(0);
    expect(mse).toBeLessThan(10);
  });

  it('4-bit has lower error than 2-bit', () => {
    const n = 64;
    const rng = mulberry32(200);
    const rotated = new Float32Array(n);
    for (let i = 0; i < n; i++) rotated[i] = (rng() - 0.5) * 6;

    const mse = (bits: CompressionBits) => {
      const { quantized, scale, zeroPoint } = uniformQuantize(rotated, bits);
      const restored = uniformDequantize(quantized, scale, zeroPoint, bits, n);
      let sum = 0;
      for (let i = 0; i < n; i++) sum += (restored[i] - rotated[i]) ** 2;
      return sum / n;
    };

    expect(mse(4)).toBeLessThan(mse(2));
  });
});

describe('dotProduct', () => {
  it('computes correct dot product', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5, 6]);
    expect(dotProduct(a, b)).toBe(32); // 4 + 10 + 18
  });
});
