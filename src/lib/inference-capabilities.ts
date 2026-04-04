/**
 * Inference Capabilities — Runtime detection of KV cache compression
 *
 * Tracks whether the active inference server is actually compressing the
 * KV cache (e.g., llama-server with turbo3/turbo4 cache types). Context
 * window inflation should ONLY happen when turboQuantActive is true.
 *
 * Detection is authoritative: "we set it, so we know it" for LlamaCppManager,
 * and "we read it from the API" for future Ollama turbo support.
 */

export interface InferenceCapabilities {
  /** Which provider is active */
  provider: 'ollama' | 'llama-cpp' | 'mlx' | 'anthropic' | 'openrouter' | 'claude-code';
  /** Whether TurboQuant KV cache compression is confirmed active */
  turboQuantActive: boolean;
  /** Compression bits (0 = none, 2/3/4 = active) */
  turboQuantBits: 0 | 2 | 3 | 4;
  /** KV cache type for keys (e.g., 'turbo3', 'turbo4', 'q4_0', 'f16') */
  cacheTypeK: string | null;
  /** KV cache type for values */
  cacheTypeV: string | null;
  /** When this capability was detected */
  detectedAt: number;
}

/**
 * Safe default: no compression active. Use when no turbo-capable
 * server is confirmed running.
 */
export function createDefaultCapabilities(): InferenceCapabilities {
  return {
    provider: 'ollama',
    turboQuantActive: false,
    turboQuantBits: 0,
    cacheTypeK: null,
    cacheTypeV: null,
    detectedAt: Date.now(),
  };
}

/**
 * Create capabilities for a confirmed llama-server with turbo cache types.
 * Call this after LlamaCppManager.start() succeeds.
 */
export function createLlamaCppCapabilities(
  bits: 2 | 3 | 4,
  cacheTypeK: string,
  cacheTypeV: string,
): InferenceCapabilities {
  return {
    provider: 'llama-cpp',
    turboQuantActive: true,
    turboQuantBits: bits,
    cacheTypeK,
    cacheTypeV,
    detectedAt: Date.now(),
  };
}

/**
 * Create capabilities for a confirmed mlx-vlm server with TurboQuant KV cache.
 * Call this after MLXManager.start() succeeds with kv-bits enabled.
 */
export function createMLXCapabilities(
  bits: 2 | 3 | 4,
  cacheTypeK: string,
  cacheTypeV: string,
): InferenceCapabilities {
  return {
    provider: 'mlx',
    turboQuantActive: true,
    turboQuantBits: bits,
    cacheTypeK,
    cacheTypeV,
    detectedAt: Date.now(),
  };
}

/**
 * Create capabilities when Ollama reports turbo cache types.
 * For future use when Ollama adds KV cache quantization metadata.
 */
export function createOllamaCapabilities(
  bits: 2 | 3 | 4,
  cacheTypeK: string,
  cacheTypeV: string,
): InferenceCapabilities {
  return {
    provider: 'ollama',
    turboQuantActive: true,
    turboQuantBits: bits,
    cacheTypeK,
    cacheTypeV,
    detectedAt: Date.now(),
  };
}
