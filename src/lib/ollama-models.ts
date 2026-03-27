/**
 * Ollama Model Catalog & Recommendation Engine
 * Multi-family catalog with device-aware recommendations.
 */

import type { DeviceInfo, MemoryTier } from './device-info.js';
import { getMemoryTier } from './device-info.js';

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
  /** Context window size in tokens (e.g. 262144 for 256K). Used by getModelContextSize(). */
  contextSize?: number;
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
    recommended: true,
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
    tag: 'qwen3.5:27b-q4_K_M',
    label: 'Qwen3.5 27B (quantized)',
    description: 'Latest multimodal model, dense 27B. Best local quality.',
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

/** Returns a practical num_ctx to request from Ollama.
 *  Caps at `maxNumCtx` (default 16384) to avoid excessive RAM,
 *  but respects models with smaller windows. Pass a higher cap
 *  when the machine has enough RAM for larger context. */
export function getWorkingNumCtx(tag: string, maxNumCtx?: number): number {
  const full = getModelContextSize(tag);
  const cap = maxNumCtx ?? 16_384;
  return Math.min(full, cap);
}

/** Format model info for display. */
export function formatModelChoice(model: OllamaModelInfo, installed?: boolean): string {
  const suffix = installed ? ' (installed)' : '';
  const tools = model.toolCalling ? ' [tools]' : '';
  const vision = model.vision ? ' [vision]' : '';
  return `${model.label} (${model.sizeGB} GB) ${model.features.join(', ')}${tools}${vision}${suffix}`;
}
