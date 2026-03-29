/**
 * TurboQuant KV Cache Compression — Type Definitions
 *
 * Based on Google Research's TurboQuant (March 2026):
 * Two-stage compression (PolarQuant + QJL) that compresses
 * transformer KV caches from 16-bit to 2-4 bits approaching
 * the Shannon limit with zero accuracy loss.
 */

/** Target bits per value for quantization */
export type CompressionBits = 2 | 3 | 4;

/** Configuration for initializing a TurboQuant codebook */
export interface TurboQuantConfig {
  /** Target bits per value (default: 4) */
  bits: CompressionBits;
  /** Dimension of the KV cache vectors (typically 64, 96, or 128 for transformer heads) */
  dimension: number;
  /** Random seed for reproducible rotation/projection matrices */
  seed?: number;
  /** Enable QJL stage for additional compression (default: true) */
  enableQjl?: boolean;
}

/**
 * Precomputed rotation + projection matrices, reusable across all vectors.
 * Created once via createCodebook(), amortizing the O(n^3) QR decomposition cost.
 */
export interface TurboQuantCodebook {
  /** Random orthogonal matrix for PolarQuant rotation (dimension x dimension, row-major) */
  rotationMatrix: Float32Array;
  /** Random projection matrix for QJL (projectedDimension x dimension, row-major) */
  projectionMatrix: Float32Array;
  /** Dimension of the original vectors */
  dimension: number;
  /** Dimension after QJL projection */
  projectedDimension: number;
  /** Bits per value */
  bits: CompressionBits;
  /** Uniform quantization step size */
  quantStep: number;
  /** Whether QJL stage is active */
  qjlEnabled: boolean;
}

/** Compressed representation of a single KV cache vector */
export interface CompressedVector {
  /** Packed quantized values */
  data: Uint8Array;
  /** Number of original dimensions */
  originalDimension: number;
  /** Bits per value used */
  bits: CompressionBits;
  /** Scale factor for dequantization */
  scale: number;
  /** Zero point for dequantization */
  zeroPoint: number;
  /** L2 norm of the original vector (needed for QJL bias correction) */
  norm: number;
}

/** Aggregate statistics from a batch compression operation */
export interface CompressionStats {
  /** Size in bytes before compression (Float32 = 4 bytes per value) */
  originalBytes: number;
  /** Size in bytes after compression */
  compressedBytes: number;
  /** Compression ratio (originalBytes / compressedBytes) */
  compressionRatio: number;
  /** Bits per value used */
  bitsPerValue: CompressionBits;
  /** Vector dimension */
  dimension: number;
  /** Number of vectors compressed */
  vectorCount: number;
}

/** Result of context window advisory calculation */
export interface ContextAdvisory {
  /** Standard context tokens (without TurboQuant) */
  standardNumCtx: number;
  /** Enhanced context tokens (with TurboQuant compression) */
  enhancedNumCtx: number;
  /** Compression ratio applied */
  compressionRatio: number;
  /** Whether the model family supports KV cache compression */
  modelSupported: boolean;
  /** Human-readable explanation of the enhancement */
  explanation: string;
}
