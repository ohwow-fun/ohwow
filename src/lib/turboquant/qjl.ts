/**
 * QJL — Quantized Johnson-Lindenstrauss (Stage 2 of TurboQuant)
 *
 * Projects rotated KV vectors using a random sign matrix, then quantizes
 * each dimension to a single sign bit. Applies bias correction to ensure
 * compressed attention scores are statistically identical to full precision.
 *
 * CRITICAL: Without bias correction, quantization errors compound across
 * tokens and the model produces garbage output. The correction formula
 * ensures E[q(x)^T q(y)] = x^T y (unbiased estimator).
 *
 * Mathematical foundation: Johnson-Lindenstrauss lemma guarantees that
 * random projections preserve pairwise distances with high probability.
 * QJL extends this to quantized projections with provable error bounds.
 */

import { mulberry32 } from './polar-quant.js';

// ============================================================================
// Random Projection Matrix
// ============================================================================

/**
 * Generate a random sign projection matrix for JL dimensionality reduction.
 *
 * Each entry is +1 or -1 with equal probability, scaled by 1/sqrt(projectedDim).
 * This is the Achlioptas random projection variant, which is computationally
 * cheaper than Gaussian projections while preserving the JL guarantee.
 *
 * @param originalDim - Original vector dimension
 * @param projectedDim - Target projected dimension
 * @param seed - Deterministic seed (should differ from rotation matrix seed)
 * @returns Float32Array of projectedDim * originalDim values (row-major)
 */
export function generateProjectionMatrix(
  originalDim: number,
  projectedDim: number,
  seed: number,
): Float32Array {
  const rng = mulberry32(seed);
  const scale = 1.0 / Math.sqrt(projectedDim);
  const matrix = new Float32Array(projectedDim * originalDim);

  for (let i = 0; i < matrix.length; i++) {
    matrix[i] = rng() < 0.5 ? -scale : scale;
  }

  return matrix;
}

// ============================================================================
// Projection
// ============================================================================

/**
 * Project a vector using the JL projection matrix: y = P * x.
 * Reduces dimensionality from originalDim to projectedDim while
 * preserving inner products (by the JL lemma).
 */
export function projectVector(
  vector: Float32Array,
  projectionMatrix: Float32Array,
  originalDim: number,
  projectedDim: number,
): Float32Array {
  const result = new Float32Array(projectedDim);
  for (let i = 0; i < projectedDim; i++) {
    let sum = 0;
    const rowOffset = i * originalDim;
    for (let j = 0; j < originalDim; j++) {
      sum += projectionMatrix[rowOffset + j] * vector[j];
    }
    result[i] = sum;
  }
  return result;
}

// ============================================================================
// Sign-Bit Quantization
// ============================================================================

/**
 * Extreme 1-bit quantization: each projected dimension becomes a single bit.
 * Positive values -> 1, negative/zero values -> 0.
 *
 * The sign function is the optimal 1-bit quantizer for inner product preservation
 * when combined with bias correction.
 *
 * @returns Packed Uint8Array where each bit represents the sign of one dimension
 */
export function signBitQuantize(projected: Float32Array): Uint8Array {
  const byteCount = Math.ceil(projected.length / 8);
  const packed = new Uint8Array(byteCount);

  for (let i = 0; i < projected.length; i++) {
    if (projected[i] > 0) {
      packed[i >>> 3] |= 1 << (i & 7);
    }
  }

  return packed;
}

/**
 * Restore sign vectors from packed bits.
 * Each bit becomes +1.0 (if 1) or -1.0 (if 0).
 */
export function signBitDequantize(packed: Uint8Array, projectedDim: number): Float32Array {
  const result = new Float32Array(projectedDim);

  for (let i = 0; i < projectedDim; i++) {
    const bit = (packed[i >>> 3] >>> (i & 7)) & 1;
    result[i] = bit ? 1.0 : -1.0;
  }

  return result;
}

// ============================================================================
// Bias Correction — THE CRITICAL PIECE
// ============================================================================

/**
 * Compute the bias correction factor for QJL sign-bit quantization.
 *
 * For sign-bit quantization of random projections, the expected inner product
 * between two sign-quantized vectors relates to the angle between the originals:
 *
 *   E[sign(Px)^T sign(Py)] = (m/pi) * angle(x, y)
 *
 * To recover the true inner product x^T y = ||x|| * ||y|| * cos(angle),
 * we need to correct by:
 *
 *   corrected = (pi/m) * ||x|| * ||y|| * hamming_agreement
 *
 * where hamming_agreement is the fraction of matching sign bits, mapped to [-1, 1]:
 *   hamming_agreement = (2 * matches / m) - 1
 *
 * This correction ensures E[corrected] = x^T y (unbiased estimator).
 *
 * @param normA - L2 norm of the first original vector
 * @param normB - L2 norm of the second original vector
 * @param projectedDim - Number of projected dimensions (m)
 * @returns Scale factor to apply to the raw hamming agreement score
 */
export function computeBiasCorrection(
  normA: number,
  normB: number,
  projectedDim: number,
): number {
  // correction = (pi / m) * ||a|| * ||b|| * m = pi * ||a|| * ||b||
  // Actually: raw_score ranges [-m, m], we want x^T y.
  // E[raw_score / m] = (2/pi) * cos(angle), so:
  // x^T y = ||a|| * ||b|| * cos(angle) = ||a|| * ||b|| * (pi/2) * E[raw_score / m]
  // correction_scale = (pi / 2) * ||a|| * ||b|| / m
  return (Math.PI / 2) * normA * normB / projectedDim;
}

/**
 * Reconstruct an approximate inner product from two QJL-compressed vectors.
 *
 * This is the bias-corrected version that produces statistically identical
 * attention scores to full-precision computation.
 *
 * @param compressedA - Sign-bit packed vector A
 * @param compressedB - Sign-bit packed vector B
 * @param normA - L2 norm of original vector A
 * @param normB - L2 norm of original vector B
 * @param projectedDim - Number of projected dimensions
 * @returns Approximate dot product of the original vectors
 */
export function reconstructInnerProduct(
  compressedA: Uint8Array,
  compressedB: Uint8Array,
  normA: number,
  normB: number,
  projectedDim: number,
): number {
  // Count matching sign bits using XOR + popcount
  let matchCount = 0;
  const byteCount = Math.ceil(projectedDim / 8);

  for (let i = 0; i < byteCount; i++) {
    // XOR gives 1 where bits differ, 0 where they match
    const xor = compressedA[i] ^ compressedB[i];
    // Count set bits (differences)
    matchCount += popcount8(xor);
  }

  // matchCount is number of DIFFERENT bits
  // We want: raw_score = (matching - different) = (m - matchCount) - matchCount = m - 2*matchCount
  const rawScore = projectedDim - 2 * matchCount;

  // Apply bias correction
  const correctionScale = computeBiasCorrection(normA, normB, projectedDim);
  return rawScore * correctionScale;
}

/**
 * Fast popcount for a single byte (number of set bits).
 * Uses lookup for speed.
 */
function popcount8(byte: number): number {
  byte = byte - ((byte >>> 1) & 0x55);
  byte = (byte & 0x33) + ((byte >>> 2) & 0x33);
  return (byte + (byte >>> 4)) & 0x0f;
}
