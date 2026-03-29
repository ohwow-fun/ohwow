/**
 * PolarQuant — Stage 1 of TurboQuant
 *
 * Rotates KV cache vectors using random orthogonal matrices so their
 * distribution becomes uniform and predictable. This eliminates outlier
 * dimensions, allowing a fixed quantizer to work without per-token calibration
 * and removing the 1-2 bits of metadata overhead that previous methods waste.
 *
 * Key insight: after orthogonal rotation, all dimensions have similar scale,
 * so a single precomputed quantization step size works for every token.
 */

import type { CompressionBits } from './types.js';

// ============================================================================
// Seeded PRNG — deterministic random number generation
// ============================================================================

/**
 * Mulberry32: fast 32-bit seeded PRNG.
 * Returns a function that produces uniform floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a pair of independent standard normal samples via Box-Muller transform.
 */
export function boxMullerGaussian(rng: () => number): [number, number] {
  const u1 = rng();
  const u2 = rng();
  // Avoid log(0) — clamp u1 to a small positive value
  const r = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-30)));
  const theta = 2 * Math.PI * u2;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

// ============================================================================
// Orthogonal Matrix Generation — Householder QR decomposition
// ============================================================================

/**
 * Generate a random orthogonal matrix Q via QR decomposition of a random
 * Gaussian matrix. Uses Householder reflections for numerical stability.
 *
 * Complexity: O(n^3) — only called once per codebook. For typical transformer
 * head dimensions (64-128), this is ~2M operations, completing in <1ms.
 *
 * @param dimension - Size of the square orthogonal matrix
 * @param seed - Deterministic seed for the PRNG
 * @returns Float32Array of dimension*dimension values (row-major)
 */
export function generateOrthogonalMatrix(dimension: number, seed: number): Float32Array {
  const n = dimension;
  const rng = mulberry32(seed);

  // Fill n x n matrix A with Gaussian random values
  const A = new Float64Array(n * n);
  for (let i = 0; i < n * n; i += 2) {
    const [g1, g2] = boxMullerGaussian(rng);
    A[i] = g1;
    if (i + 1 < n * n) A[i + 1] = g2;
  }

  // Householder QR decomposition: A = Q * R
  // We accumulate Q by applying Householder reflectors
  const Q = new Float64Array(n * n);
  // Initialize Q as identity
  for (let i = 0; i < n; i++) Q[i * n + i] = 1.0;

  for (let k = 0; k < n - 1; k++) {
    // Extract column k of the current submatrix (rows k..n-1)
    const vLen = n - k;
    const v = new Float64Array(vLen);
    let colNorm = 0;
    for (let i = 0; i < vLen; i++) {
      v[i] = A[(k + i) * n + k];
      colNorm += v[i] * v[i];
    }
    colNorm = Math.sqrt(colNorm);

    if (colNorm < 1e-15) continue;

    // Householder vector: v = x - sign(x0)*||x||*e1
    const sign = v[0] >= 0 ? 1 : -1;
    v[0] += sign * colNorm;

    // Normalize v
    let vNorm = 0;
    for (let i = 0; i < vLen; i++) vNorm += v[i] * v[i];
    vNorm = Math.sqrt(vNorm);
    if (vNorm < 1e-15) continue;
    for (let i = 0; i < vLen; i++) v[i] /= vNorm;

    // Apply Householder reflection to A: A = (I - 2vv^T) * A
    // For columns j = k..n-1 of A
    for (let j = k; j < n; j++) {
      let dot = 0;
      for (let i = 0; i < vLen; i++) dot += v[i] * A[(k + i) * n + j];
      for (let i = 0; i < vLen; i++) A[(k + i) * n + j] -= 2 * dot * v[i];
    }

    // Accumulate into Q: Q = Q * (I - 2vv^T)
    // For each row i of Q
    for (let i = 0; i < n; i++) {
      let dot = 0;
      for (let j = 0; j < vLen; j++) dot += Q[i * n + (k + j)] * v[j];
      for (let j = 0; j < vLen; j++) Q[i * n + (k + j)] -= 2 * dot * v[j];
    }
  }

  // Ensure det(Q) = +1 (proper rotation, not reflection)
  // Compute determinant sign by checking the diagonal of R
  let detSign = 1;
  for (let i = 0; i < n; i++) {
    if (A[i * n + i] < 0) detSign *= -1;
  }
  if (detSign < 0) {
    // Negate first column of Q to fix orientation
    for (let i = 0; i < n; i++) Q[i * n] = -Q[i * n];
  }

  // Convert to Float32
  const result = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) result[i] = Q[i];
  return result;
}

// ============================================================================
// Vector Rotation
// ============================================================================

/**
 * Rotate a vector by multiplying with the orthogonal matrix: y = Q * x.
 * After rotation, the distribution becomes more uniform (no outlier dimensions).
 */
export function rotateVector(
  vector: Float32Array,
  rotationMatrix: Float32Array,
  dimension: number,
): Float32Array {
  const result = new Float32Array(dimension);
  for (let i = 0; i < dimension; i++) {
    let sum = 0;
    const rowOffset = i * dimension;
    for (let j = 0; j < dimension; j++) {
      sum += rotationMatrix[rowOffset + j] * vector[j];
    }
    result[i] = sum;
  }
  return result;
}

/**
 * Inverse rotation using the transpose of the orthogonal matrix: x = Q^T * y.
 * For orthogonal Q, Q^T = Q^{-1}.
 */
export function inverseRotateVector(
  rotated: Float32Array,
  rotationMatrix: Float32Array,
  dimension: number,
): Float32Array {
  const result = new Float32Array(dimension);
  // Q^T * y: row i of Q^T = column i of Q
  for (let i = 0; i < dimension; i++) {
    let sum = 0;
    for (let j = 0; j < dimension; j++) {
      sum += rotationMatrix[j * dimension + i] * rotated[j];
    }
    result[i] = sum;
  }
  return result;
}

// ============================================================================
// Bit Packing
// ============================================================================

/**
 * Pack an array of small unsigned integers into a Uint8Array.
 * Each value uses exactly `bits` bits.
 */
export function packBits(values: Uint8Array, bits: CompressionBits): Uint8Array {
  const totalBits = values.length * bits;
  const packed = new Uint8Array(Math.ceil(totalBits / 8));

  let bitPos = 0;
  for (let i = 0; i < values.length; i++) {
    const val = values[i];
    const byteIdx = bitPos >>> 3;
    const bitOffset = bitPos & 7;

    // Write value across byte boundaries
    packed[byteIdx] |= (val << bitOffset) & 0xff;
    if (bitOffset + bits > 8) {
      packed[byteIdx + 1] |= val >>> (8 - bitOffset);
    }
    if (bitOffset + bits > 16) {
      packed[byteIdx + 2] |= val >>> (16 - bitOffset);
    }

    bitPos += bits;
  }

  return packed;
}

/**
 * Unpack a Uint8Array back into an array of small unsigned integers.
 */
export function unpackBits(packed: Uint8Array, bits: CompressionBits, count: number): Uint8Array {
  const mask = (1 << bits) - 1;
  const values = new Uint8Array(count);

  let bitPos = 0;
  for (let i = 0; i < count; i++) {
    const byteIdx = bitPos >>> 3;
    const bitOffset = bitPos & 7;

    // Read value across byte boundaries
    let val = (packed[byteIdx] >>> bitOffset) & mask;
    if (bitOffset + bits > 8 && byteIdx + 1 < packed.length) {
      val |= ((packed[byteIdx + 1] << (8 - bitOffset)) & mask);
    }
    if (bitOffset + bits > 16 && byteIdx + 2 < packed.length) {
      val |= ((packed[byteIdx + 2] << (16 - bitOffset)) & mask);
    }
    values[i] = val & mask;

    bitPos += bits;
  }

  return values;
}

// ============================================================================
// Uniform Scalar Quantization
// ============================================================================

/**
 * Uniform scalar quantization of a rotated vector.
 *
 * Because PolarQuant ensures the rotated distribution is near-uniform,
 * a fixed quantizer works without per-token calibration. No metadata overhead.
 *
 * Maps the range [min, max] to [0, 2^bits - 1] uniformly.
 */
export function uniformQuantize(
  rotated: Float32Array,
  bits: CompressionBits,
): { quantized: Uint8Array; scale: number; zeroPoint: number } {
  const levels = (1 << bits) - 1; // e.g. 15 for 4-bit

  // Find range
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < rotated.length; i++) {
    if (rotated[i] < min) min = rotated[i];
    if (rotated[i] > max) max = rotated[i];
  }

  const range = max - min;
  const scale = range > 1e-10 ? range / levels : 1;
  const zeroPoint = min;

  // Quantize to [0, levels]
  const raw = new Uint8Array(rotated.length);
  for (let i = 0; i < rotated.length; i++) {
    const normalized = (rotated[i] - zeroPoint) / scale;
    raw[i] = Math.round(Math.max(0, Math.min(levels, normalized)));
  }

  // Pack into compact bit representation
  const packed = packBits(raw, bits);
  return { quantized: packed, scale, zeroPoint };
}

/**
 * Dequantize back to Float32Array (inverse of uniformQuantize).
 */
export function uniformDequantize(
  quantized: Uint8Array,
  scale: number,
  zeroPoint: number,
  bits: CompressionBits,
  count: number,
): Float32Array {
  const raw = unpackBits(quantized, bits, count);
  const result = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = raw[i] * scale + zeroPoint;
  }
  return result;
}

/**
 * Compute the L2 norm of a vector.
 */
export function vectorNorm(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

/**
 * Compute the dot product of two vectors.
 */
export function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}
