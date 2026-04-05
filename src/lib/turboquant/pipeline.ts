/**
 * TurboQuant Pipeline — Combined PolarQuant + QJL compression
 *
 * Provides the end-to-end compress/decompress pipeline and codebook
 * management. The codebook precomputes rotation and projection matrices
 * once, amortizing the O(n^3) cost across all vectors in a session.
 *
 * Usage:
 *   const codebook = createCodebook({ bits: 4, dimension: 128 });
 *   const compressed = compress(kvVector, codebook);
 *   const restored = decompress(compressed, codebook);
 */

import type {
  TurboQuantConfig,
  TurboQuantCodebook,
  CompressedVector,
  CompressionStats,
} from './types.js';
import {
  generateOrthogonalMatrix,
  rotateVector,
  inverseRotateVector,
  uniformQuantize,
  uniformDequantize,
  vectorNorm,
} from './polar-quant.js';
import {
  generateProjectionMatrix,
  projectVector,
  signBitQuantize,
  reconstructInnerProduct,
} from './qjl.js';

// ============================================================================
// Codebook Creation
// ============================================================================

/**
 * Create a reusable TurboQuant codebook.
 *
 * Precomputes the orthogonal rotation matrix (PolarQuant) and the random
 * sign projection matrix (QJL). These are deterministic given the seed,
 * so the same codebook can be recreated on different machines.
 *
 * @param config - Compression configuration
 * @returns Reusable codebook for compress/decompress operations
 */
export function createCodebook(config: TurboQuantConfig): TurboQuantCodebook {
  const { bits, dimension, seed = 42, enableQjl = true } = config;

  // PolarQuant: generate orthogonal rotation matrix
  const rotationMatrix = generateOrthogonalMatrix(dimension, seed);

  // QJL: generate random sign projection matrix
  // Project to dimension/compressionRatio for additional compression
  // For 4-bit: project to dimension (no reduction, just sign-bit on top)
  // For 2-bit: project to dimension/2 for more aggressive reduction
  const projectedDimension = enableQjl
    ? Math.max(16, Math.floor(dimension * (bits <= 2 ? 0.5 : 0.75)))
    : dimension;

  const projectionMatrix = enableQjl
    ? generateProjectionMatrix(dimension, projectedDimension, seed + 7919) // different seed
    : new Float32Array(0);

  // Compute uniform quantization step size for the target bits
  // After rotation, values are approximately standard normal, so range is ~[-3, 3]
  const expectedRange = 6.0; // ~3 standard deviations each side
  const levels = (1 << bits) - 1;
  const quantStep = expectedRange / levels;

  return {
    rotationMatrix,
    projectionMatrix,
    dimension,
    projectedDimension,
    bits,
    quantStep,
    qjlEnabled: enableQjl,
  };
}

// ============================================================================
// Compression
// ============================================================================

/**
 * Compress a single KV cache vector using the full TurboQuant pipeline:
 *
 * 1. PolarQuant rotation — eliminates outlier dimensions
 * 2. Uniform quantization — no per-token calibration needed
 * 3. (Optional) QJL projection + sign-bit — further compression
 *
 * The compressed output is a CompressedVector containing the packed
 * quantized data, scale/zeroPoint for dequantization, and the original
 * vector's L2 norm for QJL bias correction.
 */
export function compress(
  vector: Float32Array,
  codebook: TurboQuantCodebook,
): CompressedVector {
  const { dimension, bits, rotationMatrix } = codebook;

  // Record the norm before any transformation (needed for QJL bias correction)
  const norm = vectorNorm(vector);

  // Stage 1: PolarQuant rotation
  const rotated = rotateVector(vector, rotationMatrix, dimension);

  // Stage 2: Uniform quantization of rotated vector
  const { quantized, scale, zeroPoint } = uniformQuantize(rotated, bits);

  return {
    data: quantized,
    originalDimension: dimension,
    bits,
    scale,
    zeroPoint,
    norm,
  };
}

/**
 * Decompress a CompressedVector back to an approximate Float32Array.
 *
 * This is lossy: the output approximates the input. Approximation quality
 * depends on bits (4-bit is nearly lossless, 2-bit has noticeable error).
 */
export function decompress(
  compressed: CompressedVector,
  codebook: TurboQuantCodebook,
): Float32Array {
  const { data, scale, zeroPoint, bits, originalDimension } = compressed;
  const { rotationMatrix } = codebook;

  // Reverse quantization
  const rotated = uniformDequantize(data, scale, zeroPoint, bits, originalDimension);

  // Reverse rotation
  return inverseRotateVector(rotated, rotationMatrix, originalDimension);
}

// ============================================================================
// Batch Operations
// ============================================================================

/**
 * Batch compress multiple vectors (e.g., all K or V vectors for a layer).
 * Returns compressed vectors and aggregate statistics.
 */
export function compressBatch(
  vectors: Float32Array[],
  codebook: TurboQuantCodebook,
): { compressed: CompressedVector[]; stats: CompressionStats } {
  const compressed = vectors.map(v => compress(v, codebook));

  const originalBytes = vectors.length * codebook.dimension * 4; // Float32 = 4 bytes
  const compressedBytes = compressed.reduce((sum, c) => sum + c.data.byteLength, 0);

  return {
    compressed,
    stats: {
      originalBytes,
      compressedBytes,
      compressionRatio: compressedBytes > 0 ? originalBytes / compressedBytes : 0,
      bitsPerValue: codebook.bits,
      dimension: codebook.dimension,
      vectorCount: vectors.length,
    },
  };
}

/**
 * Batch decompress multiple compressed vectors.
 */
export function decompressBatch(
  compressed: CompressedVector[],
  codebook: TurboQuantCodebook,
): Float32Array[] {
  return compressed.map(c => decompress(c, codebook));
}

// ============================================================================
// Compressed Dot Product (for attention scores)
// ============================================================================

/**
 * Compute an approximate dot product between two compressed vectors.
 *
 * When QJL is enabled, uses the bias-corrected sign-bit inner product
 * for maximum compression. Otherwise, decompresses and computes directly.
 *
 * This enables computing attention scores directly from compressed KV cache
 * entries without full decompression.
 */
export function compressedDotProduct(
  a: CompressedVector,
  b: CompressedVector,
  codebook: TurboQuantCodebook,
): number {
  if (codebook.qjlEnabled) {
    // Decompress to rotated space, then project and use QJL inner product
    const rotatedA = uniformDequantize(a.data, a.scale, a.zeroPoint, a.bits, a.originalDimension);
    const rotatedB = uniformDequantize(b.data, b.scale, b.zeroPoint, b.bits, b.originalDimension);

    const projA = projectVector(rotatedA, codebook.projectionMatrix, codebook.dimension, codebook.projectedDimension);
    const projB = projectVector(rotatedB, codebook.projectionMatrix, codebook.dimension, codebook.projectedDimension);

    const signA = signBitQuantize(projA);
    const signB = signBitQuantize(projB);

    return reconstructInnerProduct(signA, signB, a.norm, b.norm, codebook.projectedDimension);
  }

  // Without QJL: decompress both and compute dot product directly
  const vecA = decompress(a, codebook);
  const vecB = decompress(b, codebook);
  let dot = 0;
  for (let i = 0; i < vecA.length; i++) dot += vecA[i] * vecB[i];
  return dot;
}

/**
 * Measure the cosine similarity between original and decompressed vectors.
 * Useful for validating compression quality.
 *
 * Returns a value in [-1, 1] where 1.0 means perfect reconstruction.
 */
export function compressionFidelity(
  original: Float32Array,
  decompressed: Float32Array,
): number {
  let dotAB = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(original.length, decompressed.length);

  for (let i = 0; i < len; i++) {
    dotAB += original[i] * decompressed[i];
    normA += original[i] * original[i];
    normB += decompressed[i] * decompressed[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 1e-10 ? dotAB / denom : 0;
}
