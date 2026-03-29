/**
 * GGUF Model File Resolution
 *
 * Locates GGUF model files for llama-server by searching:
 * 1. Explicit path from config
 * 2. Ollama blob storage (~/.ollama/models/)
 * 3. ohwow models directory (~/.ohwow/models/)
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';

const OLLAMA_MODELS_DIR = join(homedir(), '.ollama', 'models');
const OHWOW_MODELS_DIR = join(homedir(), '.ohwow', 'models');

/**
 * Parse a model tag into name and variant.
 * Examples: 'qwen3:4b' -> { name: 'qwen3', variant: '4b' }
 *           'llama3.1:8b' -> { name: 'llama3.1', variant: '8b' }
 *           'qwen3' -> { name: 'qwen3', variant: 'latest' }
 */
export function parseModelTag(tag: string): { name: string; variant: string } {
  const parts = tag.split(':');
  return {
    name: parts[0],
    variant: parts[1] || 'latest',
  };
}

/**
 * Resolve a GGUF model file path for llama-server.
 *
 * @param modelTag - Ollama-style model tag (e.g., 'qwen3:4b')
 * @param explicitPath - Optional explicit GGUF file path from config
 * @returns Absolute path to the GGUF file
 * @throws If no GGUF file can be found
 */
export async function resolveGgufPath(
  modelTag: string,
  explicitPath?: string,
): Promise<string> {
  // 1. Explicit path from config
  if (explicitPath && existsSync(explicitPath)) {
    logger.debug({ path: explicitPath }, '[llama-cpp-gguf] Using explicit model path');
    return explicitPath;
  }
  if (explicitPath) {
    logger.warn({ path: explicitPath }, '[llama-cpp-gguf] Explicit model path not found, trying Ollama blobs');
  }

  // 2. Ollama blob storage lookup
  const ollamaPath = resolveFromOllamaBlobs(modelTag);
  if (ollamaPath) {
    logger.debug({ path: ollamaPath, tag: modelTag }, '[llama-cpp-gguf] Resolved from Ollama blobs');
    return ollamaPath;
  }

  // 3. Fallback: scan ~/.ohwow/models/
  const ohwowPath = resolveFromOhwowModels(modelTag);
  if (ohwowPath) {
    logger.debug({ path: ohwowPath, tag: modelTag }, '[llama-cpp-gguf] Resolved from ohwow models directory');
    return ohwowPath;
  }

  throw new Error(
    `Could not find GGUF file for model "${modelTag}". ` +
    'Either pull it with Ollama first (ollama pull ' + modelTag + '), ' +
    'place a .gguf file in ~/.ohwow/models/, or set llamaCppModelPath in config.',
  );
}

/**
 * Look up a model's GGUF file from Ollama's internal blob storage.
 *
 * Ollama stores models as:
 *   ~/.ollama/models/manifests/registry.ollama.ai/library/{name}/{variant} (JSON manifest)
 *   ~/.ollama/models/blobs/{digest} (actual GGUF file)
 *
 * The manifest has a `layers` array. The layer with
 * mediaType "application/vnd.ollama.image.model" contains the GGUF digest.
 */
function resolveFromOllamaBlobs(modelTag: string): string | null {
  const { name, variant } = parseModelTag(modelTag);
  const manifestPath = join(OLLAMA_MODELS_DIR, 'manifests', 'registry.ollama.ai', 'library', name, variant);

  if (!existsSync(manifestPath)) return null;

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      layers?: Array<{ mediaType: string; digest: string; size?: number }>;
    };

    // Find the model layer (the actual GGUF file)
    const modelLayer = manifest.layers?.find(
      l => l.mediaType === 'application/vnd.ollama.image.model',
    );
    if (!modelLayer?.digest) return null;

    // Digest format: "sha256:abc123..." -> blob filename: "sha256-abc123..."
    const blobName = modelLayer.digest.replace(':', '-');
    const blobPath = join(OLLAMA_MODELS_DIR, 'blobs', blobName);

    if (existsSync(blobPath)) return blobPath;
    return null;
  } catch {
    return null;
  }
}

/**
 * Scan ~/.ohwow/models/ for GGUF files matching the model name.
 */
function resolveFromOhwowModels(modelTag: string): string | null {
  if (!existsSync(OHWOW_MODELS_DIR)) return null;

  const { name } = parseModelTag(modelTag);

  try {
    const files = readdirSync(OHWOW_MODELS_DIR);
    // Look for files matching the model name with .gguf extension
    const match = files.find(f =>
      f.endsWith('.gguf') && f.toLowerCase().includes(name.toLowerCase()),
    );
    if (match) return join(OHWOW_MODELS_DIR, match);

    // Fallback: return any .gguf file
    const anyGguf = files.find(f => f.endsWith('.gguf'));
    if (anyGguf) return join(OHWOW_MODELS_DIR, anyGguf);
  } catch {
    // Directory read failed
  }

  return null;
}
