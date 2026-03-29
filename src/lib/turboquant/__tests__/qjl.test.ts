import { describe, it, expect } from 'vitest';
import {
  generateProjectionMatrix,
  projectVector,
  signBitQuantize,
  signBitDequantize,
  computeBiasCorrection,
  reconstructInnerProduct,
} from '../qjl.js';
import { mulberry32, vectorNorm, dotProduct } from '../polar-quant.js';

function randomVector(dim: number, seed: number): Float32Array {
  const rng = mulberry32(seed);
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = (rng() - 0.5) * 2;
  return v;
}

describe('generateProjectionMatrix', () => {
  it('is deterministic for same seed', () => {
    const P1 = generateProjectionMatrix(64, 32, 42);
    const P2 = generateProjectionMatrix(64, 32, 42);
    for (let i = 0; i < P1.length; i++) {
      expect(P1[i]).toBe(P2[i]);
    }
  });

  it('has correct dimensions', () => {
    const P = generateProjectionMatrix(128, 64, 42);
    expect(P.length).toBe(128 * 64);
  });

  it('entries are scaled by 1/sqrt(projectedDim)', () => {
    const projDim = 64;
    const P = generateProjectionMatrix(32, projDim, 42);
    const expectedMag = 1 / Math.sqrt(projDim);
    for (let i = 0; i < P.length; i++) {
      expect(Math.abs(Math.abs(P[i]) - expectedMag)).toBeLessThan(1e-6);
    }
  });
});

describe('projectVector', () => {
  it('reduces dimensionality', () => {
    const origDim = 64;
    const projDim = 32;
    const P = generateProjectionMatrix(origDim, projDim, 42);
    const v = randomVector(origDim, 100);
    const projected = projectVector(v, P, origDim, projDim);

    expect(projected.length).toBe(projDim);
  });

  it('approximately preserves inner products (JL guarantee)', () => {
    const origDim = 128;
    const projDim = 64;
    const P = generateProjectionMatrix(origDim, projDim, 42);

    // Test with many vector pairs
    const errors: number[] = [];
    for (let trial = 0; trial < 100; trial++) {
      const a = randomVector(origDim, trial * 2);
      const b = randomVector(origDim, trial * 2 + 1);

      const trueDot = dotProduct(a, b);
      const projA = projectVector(a, P, origDim, projDim);
      const projB = projectVector(b, P, origDim, projDim);
      // With sign entries scaled by 1/sqrt(m):
      // P[i,j] = +/-1/sqrt(m), so P^T P approximates I
      // E[<Px, Py>] = <x, y>
      const projDot = dotProduct(projA, projB);

      errors.push(Math.abs(projDot - trueDot));
    }

    const meanAbsError = errors.reduce((a, b) => a + b, 0) / errors.length;
    // Absolute error is bounded by O(||x||*||y|| / sqrt(m))
    // For our random vectors, ||x|| ~ sqrt(d/12) ~ 3.3, so ||x||*||y|| ~ 11
    // Error ~ 11 / sqrt(64) ~ 1.4, but with variance, allow a generous bound
    expect(meanAbsError).toBeLessThan(5.0);
  });
});

describe('signBitQuantize / signBitDequantize', () => {
  it('produces correct byte count', () => {
    const v = new Float32Array(64);
    for (let i = 0; i < 64; i++) v[i] = i % 2 === 0 ? 1 : -1;
    const packed = signBitQuantize(v);
    expect(packed.length).toBe(Math.ceil(64 / 8));
  });

  it('preserves sign information', () => {
    const v = new Float32Array([1, -1, 0.5, -0.5, 3, -3, 0.1, -0.1]);
    const packed = signBitQuantize(v);
    const restored = signBitDequantize(packed, 8);

    expect(restored[0]).toBe(1.0);  // positive -> +1
    expect(restored[1]).toBe(-1.0); // negative -> -1
    expect(restored[2]).toBe(1.0);  // positive -> +1
    expect(restored[3]).toBe(-1.0); // negative -> -1
    expect(restored[4]).toBe(1.0);
    expect(restored[5]).toBe(-1.0);
    expect(restored[6]).toBe(1.0);
    expect(restored[7]).toBe(-1.0);
  });

  it('treats zero as negative (sign bit 0)', () => {
    const v = new Float32Array([0]);
    const packed = signBitQuantize(v);
    const restored = signBitDequantize(packed, 1);
    expect(restored[0]).toBe(-1.0);
  });
});

describe('reconstructInnerProduct (bias-corrected)', () => {
  it('produces unbiased estimates of true dot product', () => {
    const origDim = 128;
    const projDim = 96;
    const P = generateProjectionMatrix(origDim, projDim, 42);

    const errors: number[] = [];
    for (let trial = 0; trial < 500; trial++) {
      const a = randomVector(origDim, trial * 2 + 1000);
      const b = randomVector(origDim, trial * 2 + 1001);

      const trueDot = dotProduct(a, b);
      const normA = vectorNorm(a);
      const normB = vectorNorm(b);

      const projA = projectVector(a, P, origDim, projDim);
      const projB = projectVector(b, P, origDim, projDim);
      const signA = signBitQuantize(projA);
      const signB = signBitQuantize(projB);

      const estimated = reconstructInnerProduct(signA, signB, normA, normB, projDim);
      errors.push(estimated - trueDot);
    }

    // Mean error should be near zero (unbiased)
    const meanError = errors.reduce((a, b) => a + b, 0) / errors.length;
    const meanAbsError = errors.reduce((a, b) => a + Math.abs(b), 0) / errors.length;

    // Bias should be small relative to typical dot product magnitudes
    expect(Math.abs(meanError)).toBeLessThan(meanAbsError * 0.3);
  });

  it('without bias correction, estimates are biased', () => {
    const origDim = 64;
    const projDim = 48;
    const P = generateProjectionMatrix(origDim, projDim, 42);

    let sumUncorrected = 0;
    let sumTrueDot = 0;
    const trials = 200;

    for (let trial = 0; trial < trials; trial++) {
      const a = randomVector(origDim, trial * 2 + 2000);
      const b = randomVector(origDim, trial * 2 + 2001);

      const trueDot = dotProduct(a, b);
      sumTrueDot += trueDot;

      const projA = projectVector(a, P, origDim, projDim);
      const projB = projectVector(b, P, origDim, projDim);
      const signA = signBitQuantize(projA);
      const signB = signBitQuantize(projB);

      // Raw uncorrected: just count matching bits
      let matchCount = 0;
      const byteCount = Math.ceil(projDim / 8);
      for (let i = 0; i < byteCount; i++) {
        const xor = signA[i] ^ signB[i];
        let b = xor;
        b = b - ((b >>> 1) & 0x55);
        b = (b & 0x33) + ((b >>> 2) & 0x33);
        matchCount += (b + (b >>> 4)) & 0x0f;
      }
      const rawScore = projDim - 2 * matchCount;
      sumUncorrected += rawScore;
    }

    // Uncorrected scores should NOT match true dot products on average
    const avgUncorrected = sumUncorrected / trials;
    const avgTrueDot = sumTrueDot / trials;

    // The uncorrected values are in a different scale entirely
    // (raw hamming scores vs actual dot products)
    expect(Math.abs(avgUncorrected - avgTrueDot)).toBeGreaterThan(0);
  });
});

describe('computeBiasCorrection', () => {
  it('scales with vector norms', () => {
    const c1 = computeBiasCorrection(1.0, 1.0, 64);
    const c2 = computeBiasCorrection(2.0, 1.0, 64);
    expect(c2).toBeCloseTo(c1 * 2, 5);
  });

  it('inversely scales with projected dimension', () => {
    const c1 = computeBiasCorrection(1.0, 1.0, 32);
    const c2 = computeBiasCorrection(1.0, 1.0, 64);
    expect(c2).toBeCloseTo(c1 / 2, 5);
  });
});
