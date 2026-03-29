/**
 * TurboQuant Context Advisor
 *
 * Calculates enhanced context window sizes when TurboQuant-compatible
 * KV cache compression is available. Integrates with the existing
 * computeDynamicNumCtx logic in ollama-models.ts.
 *
 * The key insight: if the KV cache is compressed N times (16-bit to 16/N bits),
 * the same RAM can hold N times more context tokens. The existing formula uses
 * ~500 tokens per MB for Q4 models. With TurboQuant compression, this multiplier
 * increases proportionally.
 */

import type { CompressionBits, ContextAdvisory } from './types.js';
import type { DeviceInfo } from '../device-info.js';
import { getModelContextSize } from '../ollama-models.js';

// ============================================================================
// Compression Ratio Estimates by Model Family
// ============================================================================

/** Default compression ratios by model family and bit width */
const FAMILY_COMPRESSION_RATIOS: Record<string, { ratio4bit: number; ratio2bit: number }> = {
  qwen: { ratio4bit: 3.8, ratio2bit: 7.0 },
  llama: { ratio4bit: 3.8, ratio2bit: 7.0 },
  gemma: { ratio4bit: 4.0, ratio2bit: 7.5 },
  phi: { ratio4bit: 3.0, ratio2bit: 6.0 },
  // DeepSeek uses Multi-head Latent Attention which already compresses KV
  deepseek: { ratio4bit: 1.5, ratio2bit: 2.5 },
};

// ============================================================================
// Compression Ratio Calculation
// ============================================================================

/**
 * Compute the effective compression ratio for a given bit width.
 *
 * Theoretical ratio = 16 / bits (FP16 baseline).
 * Effective ratio includes a 5% overhead margin for metadata (scale, zeroPoint per vector).
 * TurboQuant's PolarQuant eliminates most metadata overhead, but we're conservative.
 */
export function effectiveCompressionRatio(bits: CompressionBits): number {
  return (16 / bits) * 0.95;
}

/**
 * Get the family-specific compression ratio for a model tag.
 * Falls back to a conservative default if the family isn't recognized.
 */
export function getFamilyCompressionRatio(
  family: string,
  bits: CompressionBits,
): number {
  const ratios = FAMILY_COMPRESSION_RATIOS[family];
  if (!ratios) {
    // Conservative default for unknown families
    return bits <= 2 ? 5.0 : bits === 3 ? 3.5 : 3.0;
  }
  if (bits <= 2) return ratios.ratio2bit;
  if (bits >= 4) return ratios.ratio4bit;
  // 3-bit: interpolate between 2-bit and 4-bit
  return (ratios.ratio2bit + ratios.ratio4bit) / 2;
}

// ============================================================================
// Enhanced Context Window Calculation
// ============================================================================

/**
 * Compute enhanced context window size accounting for TurboQuant compression.
 *
 * This wraps the same logic as computeDynamicNumCtx but applies the
 * compression multiplier to the tokens-per-MB estimate. The result
 * represents the theoretical maximum context when KV cache compression
 * is active at the inference level.
 *
 * @param tag - Ollama model tag
 * @param device - Device hardware info
 * @param family - Model family (qwen, llama, gemma, phi, deepseek)
 * @param bits - TurboQuant compression bits (default: 4)
 * @returns Advisory with both standard and enhanced context sizes
 */
export function computeEnhancedNumCtx(
  tag: string,
  device: DeviceInfo,
  family: string,
  bits: CompressionBits = 4,
): ContextAdvisory {
  const nativeContext = getModelContextSize(tag);

  // Replicate the standard computation from ollama-models.ts
  const effectiveFree = Math.max(device.freeMemoryGB, device.totalMemoryGB * 0.5);
  const availableForModel = effectiveFree - 1.0;

  // We need the model size but don't import MODEL_CATALOG to avoid circular deps.
  // Use a conservative 2.5GB fallback (same as computeDynamicNumCtx).
  const modelSize = 2.5;
  const availableForContext = availableForModel - modelSize;

  if (availableForContext <= 0) {
    return {
      standardNumCtx: 4096,
      enhancedNumCtx: 4096,
      compressionRatio: 1,
      modelSupported: false,
      explanation: 'Insufficient RAM for context beyond minimum',
    };
  }

  // Standard: 500 tokens/MB for Q4 models
  const baseTokensPerMB = 500;
  const standardTokensFromRAM = Math.floor(availableForContext * 1024 * baseTokensPerMB);
  const standardSafetyCap = device.totalMemoryGB < 16 ? 65_536 : 131_072;
  const standardNumCtx = Math.max(4096, Math.min(nativeContext, standardTokensFromRAM, standardSafetyCap));

  // Enhanced: apply compression ratio with 0.85 safety margin
  const compressionRatio = getFamilyCompressionRatio(family, bits);
  const effectiveMultiplier = compressionRatio * 0.85;
  const enhancedTokensFromRAM = Math.floor(availableForContext * 1024 * baseTokensPerMB * effectiveMultiplier);
  // Raise safety caps for compressed mode (double the standard caps)
  const enhancedSafetyCap = device.totalMemoryGB < 16 ? 131_072 : 262_144;
  const enhancedNumCtx = Math.max(4096, Math.min(nativeContext, enhancedTokensFromRAM, enhancedSafetyCap));

  const improvement = enhancedNumCtx / standardNumCtx;
  const explanation = improvement > 1.1
    ? `TurboQuant ${bits}-bit compression enables ${Math.round(improvement * 10) / 10}x more context (${standardNumCtx.toLocaleString()} -> ${enhancedNumCtx.toLocaleString()} tokens)`
    : `Context already at model maximum (${nativeContext.toLocaleString()} tokens)`;

  return {
    standardNumCtx,
    enhancedNumCtx,
    compressionRatio,
    modelSupported: true,
    explanation,
  };
}
