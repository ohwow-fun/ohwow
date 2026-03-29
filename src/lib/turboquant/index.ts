/**
 * TurboQuant KV Cache Compression
 *
 * Implementation of Google Research's TurboQuant algorithm (March 2026):
 * two-stage compression (PolarQuant + QJL) that compresses transformer
 * KV caches from 16-bit to 2-4 bits approaching the Shannon limit
 * with zero accuracy loss.
 *
 * @example
 * ```typescript
 * import { createCodebook, compress, decompress, compressionFidelity } from './turboquant/index.js';
 *
 * const codebook = createCodebook({ bits: 4, dimension: 128 });
 * const compressed = compress(kvVector, codebook);
 * const restored = decompress(compressed, codebook);
 * console.log('Fidelity:', compressionFidelity(kvVector, restored)); // ~0.99+
 * ```
 */

// Types
export type {
  CompressionBits,
  TurboQuantConfig,
  TurboQuantCodebook,
  CompressedVector,
  CompressionStats,
  ContextAdvisory,
} from './types.js';

// PolarQuant (Stage 1)
export {
  mulberry32,
  generateOrthogonalMatrix,
  rotateVector,
  inverseRotateVector,
  uniformQuantize,
  uniformDequantize,
  packBits,
  unpackBits,
  vectorNorm,
  dotProduct,
} from './polar-quant.js';

// QJL (Stage 2)
export {
  generateProjectionMatrix,
  projectVector,
  signBitQuantize,
  signBitDequantize,
  computeBiasCorrection,
  reconstructInnerProduct,
} from './qjl.js';

// Pipeline
export {
  createCodebook,
  compress,
  decompress,
  compressBatch,
  decompressBatch,
  compressedDotProduct,
  compressionFidelity,
} from './pipeline.js';

// Context Advisor
export {
  effectiveCompressionRatio,
  getFamilyCompressionRatio,
  computeEnhancedNumCtx,
} from './context-advisor.js';
