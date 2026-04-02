/**
 * Ollama Model Catalog & Recommendation Engine
 * Multi-family catalog with device-aware recommendations.
 */

import type { DeviceInfo, MemoryTier } from './device-info.js';
import { getMemoryTier } from './device-info.js';
import type { CompressionBits } from './turboquant/types.js';
import { getFamilyCompressionRatio } from './turboquant/context-advisor.js';

export type ParameterTier = 'micro' | 'small' | 'medium' | 'large';

/** Infer parameter tier from model file size. */
export function inferParameterTier(sizeGB: number): ParameterTier {
  if (sizeGB < 1.0) return 'micro';
  if (sizeGB < 3.0) return 'small';
  if (sizeGB < 7.0) return 'medium';
  return 'large';
}

/** Get the parameter tier for a model by tag. Falls back to 'medium'. */
export function getParameterTier(tag: string): ParameterTier {
  const entry = MODEL_CATALOG.find(m => m.tag === tag);
  if (!entry) return 'medium';
  return inferParameterTier(entry.sizeGB);
}

export interface OllamaModelInfo {
  tag: string;
  label: string;
  description: string;
  sizeGB: number;
  minRAM: number;
  features: string[];
  /** Model family (qwen, llama, gemma, phi, deepseek) */
  family: string;
  /** Memory tier this model targets */
  tier: MemoryTier;
  /** Whether this is a recommended pick for its tier */
  recommended?: boolean;
  /** Whether this model supports function/tool calling via OpenAI-compatible API */
  toolCalling?: boolean;
  /** Whether this model supports vision/image analysis */
  vision?: boolean;
  /** Whether this model supports audio input (speech transcription and understanding) */
  audio?: boolean;
  /** Context window size in tokens (e.g. 262144 for 256K). Used by getModelContextSize(). */
  contextSize?: number;
  /** TurboQuant KV cache compression compatibility */
  turboQuant?: {
    /** Whether this model's architecture supports KV cache compression */
    compatible: boolean;
    /** Estimated compression ratio at 4-bit (e.g. 3.8x for GQA transformers) */
    ratio4bit?: number;
    /** Estimated compression ratio at 2-bit (e.g. 7.0x) */
    ratio2bit?: number;
  };
}

/** Full model catalog spanning multiple families and tiers. */
export const MODEL_CATALOG: OllamaModelInfo[] = [
  // Tiny (< 4 GB RAM)
  {
    tag: 'qwen3:0.6b',
    label: 'Qwen3 0.6B',
    description: 'Lightweight, fits on any machine. Good for simple tasks.',
    sizeGB: 0.5,
    minRAM: 4,
    features: ['text', '40K context'],
    family: 'qwen',
    tier: 'tiny',
    toolCalling: true,
    contextSize: 40_960,
  },
  {
    tag: 'gemma3:1b',
    label: 'Gemma 3 1B',
    description: 'Google\'s compact model. Fast and efficient.',
    sizeGB: 0.8,
    minRAM: 4,
    features: ['text', '32K context'],
    family: 'gemma',
    tier: 'tiny',
    contextSize: 32_768,
  },
  {
    tag: 'qwen3.5:0.8b',
    label: 'Qwen3.5 0.8B',
    description: 'Tiny multimodal model with vision and 256K context.',
    sizeGB: 1.0,
    minRAM: 4,
    features: ['text', 'vision', '256K context'],
    family: 'qwen',
    tier: 'tiny',
    toolCalling: true,
    vision: true,
    contextSize: 262_144,
  },
  // Small (4-8 GB RAM)
  {
    tag: 'qwen3:1.7b',
    label: 'Qwen3 1.7B',
    description: 'Small but capable. Works well for routine tasks.',
    sizeGB: 1.4,
    minRAM: 4,
    features: ['text', '40K context'],
    family: 'qwen',
    tier: 'small',
    toolCalling: true,
    contextSize: 40_960,
  },
  {
    tag: 'llama3.2:3b',
    label: 'Llama 3.2 3B',
    description: 'Meta\'s compact model. Great for general tasks.',
    sizeGB: 2.0,
    minRAM: 4,
    features: ['text', '128K context'],
    family: 'llama',
    tier: 'small',
    toolCalling: true,
    contextSize: 131_072,
  },
  {
    tag: 'qwen3.5:2b',
    label: 'Qwen3.5 2B',
    description: 'Small multimodal model with vision and 256K context.',
    sizeGB: 2.7,
    minRAM: 4,
    features: ['text', 'vision', '256K context'],
    family: 'qwen',
    tier: 'small',
    toolCalling: true,
    vision: true,
    contextSize: 262_144,
  },
  {
    tag: 'phi4-mini',
    label: 'Phi-4 Mini 3.8B',
    description: 'Microsoft\'s reasoning model. Beats GPT-4o on math.',
    sizeGB: 2.5,
    minRAM: 8,
    features: ['text', 'reasoning', '16K context'],
    family: 'phi',
    tier: 'small',
    toolCalling: true,
    contextSize: 16_384,
  },
  {
    tag: 'gemma4:e2b',
    label: 'Gemma 4 E2B',
    description: 'Google Gemma 4 (5.1B, 2.3B active). Vision, audio, and tool use.',
    sizeGB: 7.2,
    minRAM: 8,
    features: ['text', 'vision', 'audio', '128K context'],
    family: 'gemma',
    tier: 'small',
    toolCalling: true,
    vision: true,
    audio: true,
    contextSize: 131_072,
  },
  {
    tag: 'gemma3:4b',
    label: 'Gemma 3 4B',
    description: 'Google\'s mid-size model. Strong reasoning and vision.',
    sizeGB: 3.0,
    minRAM: 8,
    features: ['text', 'vision', '128K context'],
    family: 'gemma',
    tier: 'small',
    vision: true,
    contextSize: 131_072,
  },

  // Medium (8-16 GB RAM)
  {
    tag: 'qwen3:4b',
    label: 'Qwen3 4B',
    description: 'Great balance of speed and quality. 256K context window.',
    sizeGB: 2.5,
    minRAM: 8,
    features: ['text', '256K context'],
    family: 'qwen',
    tier: 'medium',
    toolCalling: true,
    contextSize: 262_144,
  },
  {
    tag: 'qwen3.5:4b',
    label: 'Qwen3.5 4B',
    description: 'Mid-size multimodal model with vision and 256K context.',
    sizeGB: 3.4,
    minRAM: 8,
    features: ['text', 'vision', '256K context'],
    family: 'qwen',
    tier: 'medium',
    toolCalling: true,
    vision: true,
    contextSize: 262_144,
  },
  {
    tag: 'qwen2.5:7b',
    label: 'Qwen 2.5 7B',
    description: 'Excellent all-rounder. Strong coding and instruction following.',
    sizeGB: 4.7,
    minRAM: 8,
    features: ['text', '128K context'],
    family: 'qwen',
    tier: 'medium',
    toolCalling: true,
    contextSize: 131_072,
  },
  {
    tag: 'llama3.1:8b',
    label: 'Llama 3.1 8B',
    description: 'Meta\'s workhorse model. Solid all-around with tool use.',
    sizeGB: 4.7,
    minRAM: 8,
    features: ['text', '128K context'],
    family: 'llama',
    tier: 'medium',
    toolCalling: true,
    contextSize: 131_072,
  },
  {
    tag: 'qwen2.5vl:7b',
    label: 'Qwen 2.5-VL 7B',
    description: 'Best small vision model. Reads images, charts, and documents.',
    sizeGB: 5.0,
    minRAM: 8,
    features: ['text', 'vision', '125K context'],
    family: 'qwen',
    tier: 'medium',
    vision: true,
    contextSize: 128_000,
  },
  {
    tag: 'deepseek-r1:7b',
    label: 'DeepSeek R1 7B',
    description: 'Strong reasoning model. Good at step-by-step thinking.',
    sizeGB: 4.7,
    minRAM: 8,
    features: ['text', 'reasoning', '64K context'],
    family: 'deepseek',
    tier: 'medium',
    contextSize: 65_536,
  },
  {
    tag: 'gemma3:12b-it-qat',
    label: 'Gemma 3 12B QAT',
    description: '12B quality in 6.6 GB via quantization-aware training. Vision and tool use.',
    sizeGB: 6.6,
    minRAM: 8,
    features: ['text', 'vision', '128K context'],
    family: 'gemma',
    tier: 'medium',
    toolCalling: true,
    vision: true,
    contextSize: 131_072,
  },
  {
    tag: 'gemma4:e4b',
    label: 'Gemma 4 E4B',
    description: 'Google Gemma 4 (8B, 4.5B active). Vision, audio, tool use. Best value multimodal.',
    sizeGB: 9.6,
    minRAM: 12,
    features: ['text', 'vision', 'audio', '128K context'],
    family: 'gemma',
    tier: 'medium',
    recommended: true,
    toolCalling: true,
    vision: true,
    audio: true,
    contextSize: 131_072,
  },

  // Large (16-32 GB RAM)
  {
    tag: 'qwen3:8b',
    label: 'Qwen3 8B',
    description: 'Strong reasoning, sweet spot for 16GB machines.',
    sizeGB: 5.2,
    minRAM: 16,
    features: ['text', '40K context'],
    family: 'qwen',
    tier: 'large',
    recommended: true,
    toolCalling: true,
    contextSize: 40_960,
  },
  {
    tag: 'qwen3.5:9b',
    label: 'Qwen3.5 9B',
    description: 'Strong multimodal model with vision and 256K context.',
    sizeGB: 6.6,
    minRAM: 16,
    features: ['text', 'vision', '256K context'],
    family: 'qwen',
    tier: 'large',
    toolCalling: true,
    vision: true,
    contextSize: 262_144,
  },
  {
    tag: 'gemma3:12b',
    label: 'Gemma 3 12B',
    description: 'Google\'s strong multimodal model. Vision, reasoning, and tool use.',
    sizeGB: 8.1,
    minRAM: 16,
    features: ['text', 'vision', '128K context'],
    family: 'gemma',
    tier: 'large',
    toolCalling: true,
    vision: true,
    contextSize: 131_072,
  },
  {
    tag: 'llama3.2-vision:11b',
    label: 'Llama 3.2 Vision 11B',
    description: 'Meta\'s vision model. Understands images and documents.',
    sizeGB: 7.0,
    minRAM: 16,
    features: ['text', 'vision', '128K context'],
    family: 'llama',
    tier: 'large',
    vision: true,
    contextSize: 131_072,
  },
  {
    tag: 'qwen2.5:14b',
    label: 'Qwen 2.5 14B',
    description: 'Top-tier quality at 14B. Excellent coding and reasoning.',
    sizeGB: 9.0,
    minRAM: 16,
    features: ['text', '128K context'],
    family: 'qwen',
    tier: 'large',
    toolCalling: true,
    contextSize: 131_072,
  },
  {
    tag: 'phi4:14b',
    label: 'Phi-4 14B',
    description: 'Microsoft\'s reasoning powerhouse. Excels at math and logic.',
    sizeGB: 9.1,
    minRAM: 16,
    features: ['text', 'reasoning', '16K context'],
    family: 'phi',
    tier: 'large',
    toolCalling: true,
    contextSize: 16_384,
  },
  {
    tag: 'deepseek-r1:14b',
    label: 'DeepSeek R1 14B',
    description: 'Advanced reasoning at larger scale. Complex problem solving.',
    sizeGB: 9.0,
    minRAM: 16,
    features: ['text', 'reasoning', '64K context'],
    family: 'deepseek',
    tier: 'large',
    contextSize: 65_536,
  },
  {
    tag: 'gemma3:27b-it-qat',
    label: 'Gemma 3 27B QAT',
    description: '27B quality in 14 GB via quantization-aware training. Best value per GB.',
    sizeGB: 14,
    minRAM: 16,
    features: ['text', 'vision', '128K context'],
    family: 'gemma',
    tier: 'large',
    toolCalling: true,
    vision: true,
    contextSize: 131_072,
  },
  {
    tag: 'gemma4:26b',
    label: 'Gemma 4 26B MoE',
    description: 'Google Gemma 4 MoE (26B total, 3.8B active). Fast inference with vision and tools.',
    sizeGB: 18,
    minRAM: 24,
    features: ['text', 'vision', '256K context'],
    family: 'gemma',
    tier: 'large',
    toolCalling: true,
    vision: true,
    contextSize: 262_144,
  },

  // XLarge (32GB+)
  {
    tag: 'qwen3:14b',
    label: 'Qwen3 14B',
    description: 'Excellent quality, needs 32GB RAM.',
    sizeGB: 9.3,
    minRAM: 32,
    features: ['text', '40K context'],
    family: 'qwen',
    tier: 'xlarge',
    toolCalling: true,
    contextSize: 40_960,
  },
  {
    tag: 'gemma4:31b',
    label: 'Gemma 4 31B Dense',
    description: 'Google Gemma 4 dense 31B. Arena AI #3 open model. Vision and tool calling.',
    sizeGB: 20,
    minRAM: 32,
    features: ['text', 'vision', '256K context'],
    family: 'gemma',
    tier: 'xlarge',
    recommended: true,
    toolCalling: true,
    vision: true,
    contextSize: 262_144,
  },
  {
    tag: 'gemma3:27b',
    label: 'Gemma 3 27B',
    description: 'Google\'s best open model. Multimodal with strong tool use.',
    sizeGB: 17,
    minRAM: 32,
    features: ['text', 'vision', '128K context'],
    family: 'gemma',
    tier: 'xlarge',
    toolCalling: true,
    vision: true,
    contextSize: 131_072,
  },
  {
    tag: 'qwen3.5:27b',
    label: 'Qwen3.5 27B',
    description: 'Dense multimodal model, 201 languages, vision. Best local quality.',
    sizeGB: 17,
    minRAM: 64,
    features: ['text', 'vision', '256K context'],
    family: 'qwen',
    tier: 'xlarge',
    recommended: true,
    toolCalling: true,
    vision: true,
    contextSize: 262_144,
  },
  {
    tag: 'qwen3.5:35b',
    label: 'Qwen3.5 35B (MoE)',
    description: 'MoE multimodal model (35B total, 3B active). Fast inference with strong quality.',
    sizeGB: 24,
    minRAM: 64,
    features: ['text', 'vision', '256K context'],
    family: 'qwen',
    tier: 'xlarge',
    toolCalling: true,
    vision: true,
    contextSize: 262_144,
  },
  {
    tag: 'qwq:32b',
    label: 'QwQ 32B',
    description: 'Alibaba\'s reasoning model. Exceptional at math, logic, and coding.',
    sizeGB: 20,
    minRAM: 64,
    features: ['text', 'reasoning', '128K context'],
    family: 'qwen',
    tier: 'xlarge',
    toolCalling: true,
    contextSize: 131_072,
  },
  {
    tag: 'qwen2.5-coder:32b',
    label: 'Qwen 2.5 Coder 32B',
    description: 'Best local coding model. 40+ languages, strong at code reasoning.',
    sizeGB: 20,
    minRAM: 64,
    features: ['text', 'coding', '128K context'],
    family: 'qwen',
    tier: 'xlarge',
    toolCalling: true,
    contextSize: 131_072,
  },
];

// ============================================================================
// OCR MODEL CATALOG
// ============================================================================

export interface OcrModelInfo {
  tag: string;
  label: string;
  description: string;
  sizeGB: number;
  features: string[];
}

/** Dedicated OCR/vision models for text extraction from images. */
export const OCR_MODELS: OcrModelInfo[] = [
  {
    tag: 'deepseek-ocr:3b',
    label: 'DeepSeek OCR 3B',
    description: 'Specialized 3B vision model for extracting text, tables, and structured data from images.',
    sizeGB: 6.7,
    features: ['vision', 'ocr', 'image-analysis', 'tables', 'structured-data'],
  },
];

/** Returns the default OCR model info. */
export function getOcrModel(tag?: string): OcrModelInfo | null {
  if (tag) {
    return OCR_MODELS.find(m => m.tag === tag) || null;
  }
  return OCR_MODELS[0] || null;
}

/**
 * Returns models that fit on this device, sorted best-first (largest that fits).
 * Rule: model size must be < 75% of total RAM (leave room for the OS).
 */
export function recommendModels(device: DeviceInfo): OllamaModelInfo[] {
  const maxModelSize = device.totalMemoryGB * 0.75;
  return MODEL_CATALOG
    .filter(m => m.sizeGB < maxModelSize && device.totalMemoryGB >= m.minRAM)
    .sort((a, b) => b.sizeGB - a.sizeGB);
}

/** Returns the single best model for this device, or null if nothing fits. */
export function bestModel(device: DeviceInfo): OllamaModelInfo | null {
  const models = recommendModels(device);
  // Prefer recommended models first
  const recommended = models.find(m => m.recommended);
  return recommended || models[0] || null;
}

/**
 * Returns THE single hero model recommendation for onboarding screen 2.
 * This is the one model we confidently recommend based on the device hardware.
 */
export function primaryRecommendation(device: DeviceInfo): OllamaModelInfo | null {
  const tier = getMemoryTier(device);

  // Find the recommended model for the device's tier (or the next tier down)
  const tiers: MemoryTier[] = ['xlarge', 'large', 'medium', 'small', 'tiny'];
  const startIdx = tiers.indexOf(tier);

  for (let i = startIdx; i < tiers.length; i++) {
    const recommended = MODEL_CATALOG.find(
      m => m.tier === tiers[i] && m.recommended && m.sizeGB < device.totalMemoryGB * 0.75,
    );
    if (recommended) return recommended;
  }

  // Fallback: just use bestModel logic
  return bestModel(device);
}

/**
 * Returns alternative models the user could pick instead of the primary recommendation.
 * Excludes the primary recommendation itself.
 */
export function alternativeModels(device: DeviceInfo, primaryTag?: string): OllamaModelInfo[] {
  return recommendModels(device).filter(m => m.tag !== primaryTag);
}

/**
 * Returns models that support tool/function calling, suitable for the orchestrator role.
 * Sorted best-first (largest that fits).
 */
export function toolCapableModels(device: DeviceInfo): OllamaModelInfo[] {
  return recommendModels(device).filter(m => m.toolCalling);
}

/** Returns vision-capable models that fit on this device. */
export function visionCapableModels(device: DeviceInfo): OllamaModelInfo[] {
  return recommendModels(device).filter(m => m.vision);
}

/** Returns audio-capable models that fit on this device. */
export function audioCapableModels(device: DeviceInfo): OllamaModelInfo[] {
  return recommendModels(device).filter(m => m.audio);
}

/** Estimate download time in minutes (rough, assumes 50 Mbps). */
export function estimateDownloadMinutes(sizeGB: number): number {
  const sizeMb = sizeGB * 1024;
  const speedMbps = 50;
  return Math.ceil(sizeMb / speedMbps / 60 * 8);
}

/**
 * Check if a model tag is already installed locally.
 * Normalizes comparison: matches base name and variant against installed model list.
 */
export function isModelInstalled(tag: string, installedModels: string[]): boolean {
  const tagBase = tag.split(':')[0];
  const tagVariant = tag.split(':')[1] || '';
  return installedModels.some(m => {
    const mBase = m.split(':')[0];
    const mVariant = m.split(':')[1] || '';
    return mBase === tagBase && (tagVariant === '' || mVariant === tagVariant);
  });
}

/** Returns the full context window size (in tokens) for a catalog model.
 *  Uses the structured `contextSize` field; falls back to parsing feature strings
 *  for models that only have features (e.g. custom entries). */
export function getModelContextSize(tag: string): number {
  const entry = MODEL_CATALOG.find(m => m.tag === tag);
  if (!entry) return 8192;
  if (entry.contextSize) return entry.contextSize;
  // Fallback: parse feature string (e.g. '256K context')
  const ctxFeature = entry.features.find(f => f.endsWith('context'));
  if (!ctxFeature) return 8192;
  const match = ctxFeature.match(/(\d+)K/i);
  return match ? parseInt(match[1]) * 1024 : 8192;
}

/**
 * Compute a hardware-aware context window size for a model.
 * Uses actually free RAM (not total) to account for other running processes,
 * then subtracts model weight size to get RAM available for KV cache.
 * Returns the largest safe num_ctx, capped by the model's native context size.
 *
 * Uses freeMemoryGB (from os.freemem) which reflects real-time availability,
 * with a floor of 50% of total RAM to avoid being too conservative when the
 * OS reports low free memory due to disk cache (which is reclaimable).
 *
 * When `turboQuantBits` is provided and the model family supports KV cache
 * compression, the tokens-per-MB estimate is multiplied by the family's
 * compression ratio, enabling larger context windows in the same RAM.
 */
export function computeDynamicNumCtx(
  tag: string,
  device: DeviceInfo,
  turboQuantBits?: CompressionBits,
): number {
  const entry = MODEL_CATALOG.find(m => m.tag === tag);
  const modelSize = entry?.sizeGB ?? 2.5; // conservative fallback
  const nativeContext = getModelContextSize(tag);

  // Use free memory but floor at 50% of total (OS disk cache is reclaimable)
  const effectiveFree = Math.max(device.freeMemoryGB, device.totalMemoryGB * 0.5);
  // Reserve 1GB for OS + other processes on top of what's already in use
  const availableForModel = effectiveFree - 1.0;
  // Subtract model weights to get RAM available for KV cache
  const availableForContext = availableForModel - modelSize;
  if (availableForContext <= 0) return 4096; // barely fits, use minimum

  // Base estimate: ~500 tokens per MB for Q4 quantized models
  const baseTokensPerMB = 500;

  // Apply TurboQuant compression multiplier when enabled for a supported family
  let effectiveTokensPerMB = baseTokensPerMB;
  if (turboQuantBits && entry?.family) {
    const ratio = getFamilyCompressionRatio(entry.family, turboQuantBits);
    // 0.85 safety margin accounts for compression metadata overhead
    effectiveTokensPerMB = baseTokensPerMB * ratio * 0.85;
  }

  const tokensFromRAM = Math.floor(availableForContext * 1024 * effectiveTokensPerMB);

  // Safety cap: doubled when TurboQuant is active (compressed KV cache uses less RAM)
  let ramSafetyCap: number;
  if (turboQuantBits) {
    ramSafetyCap = device.totalMemoryGB < 16 ? 131_072 : 262_144;
  } else {
    ramSafetyCap = device.totalMemoryGB < 16 ? 65_536 : 131_072;
  }

  return Math.max(4096, Math.min(nativeContext, tokensFromRAM, ramSafetyCap));
}

/** Returns a practical num_ctx to request from Ollama.
 *  When `device` is provided, computes a hardware-aware context window.
 *  Otherwise caps at `maxNumCtx` (default 16384) for backward compatibility.
 *  Pass `turboQuantBits` to enable TurboQuant-aware context sizing. */
export function getWorkingNumCtx(
  tag: string,
  maxNumCtx?: number,
  device?: DeviceInfo,
  turboQuantBits?: CompressionBits,
): number {
  const full = getModelContextSize(tag);

  if (device) {
    return computeDynamicNumCtx(tag, device, turboQuantBits);
  }

  const cap = maxNumCtx ?? 16_384;
  return Math.min(full, cap);
}

/**
 * Get TurboQuant compression info for a model, derived from its family.
 * Returns compatibility info and estimated compression ratios.
 */
export function getModelTurboQuantInfo(tag: string): {
  compatible: boolean;
  ratio4bit: number;
  ratio2bit: number;
  family: string;
} {
  const entry = MODEL_CATALOG.find(m => m.tag === tag);
  if (!entry) return { compatible: false, ratio4bit: 1, ratio2bit: 1, family: 'unknown' };

  // All standard transformer families support TurboQuant
  const ratio4bit = getFamilyCompressionRatio(entry.family, 4);
  const ratio2bit = getFamilyCompressionRatio(entry.family, 2);

  return {
    compatible: true,
    ratio4bit,
    ratio2bit,
    family: entry.family,
  };
}

/** Format model info for display. */
export function formatModelChoice(model: OllamaModelInfo, installed?: boolean): string {
  const suffix = installed ? ' (installed)' : '';
  const tools = model.toolCalling ? ' [tools]' : '';
  const vision = model.vision ? ' [vision]' : '';
  const audio = model.audio ? ' [audio]' : '';
  return `${model.label} (${model.sizeGB} GB) ${model.features.join(', ')}${tools}${vision}${audio}${suffix}`;
}
