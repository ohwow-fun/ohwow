/**
 * RAG Embeddings — Local embedding generation via Ollama.
 * Falls back gracefully when Ollama is unavailable.
 */

import { logger } from '../logger.js';

export interface EmbeddingResult {
  embedding: Float32Array;
  model: string;
}

/**
 * Generate an embedding vector for a text string using Ollama.
 * Returns null if Ollama is unavailable or the model isn't pulled.
 */
export async function generateEmbedding(
  text: string,
  ollamaUrl: string,
  model: string = 'nomic-embed-text',
): Promise<EmbeddingResult | null> {
  try {
    const response = await fetch(`${ollamaUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ model, input: text }),
    });
    if (!response.ok) return null;
    const data = await response.json() as { embeddings: number[][] };
    if (!data.embeddings?.[0]) return null;
    return {
      embedding: new Float32Array(data.embeddings[0]),
      model,
    };
  } catch {
    logger.debug('[RAG] Ollama embedding unavailable');
    return null;
  }
}

/**
 * Generate embeddings for multiple texts in a single batch call.
 */
export async function generateEmbeddings(
  texts: string[],
  ollamaUrl: string,
  model: string = 'nomic-embed-text',
): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];
  try {
    const response = await fetch(`${ollamaUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ model, input: texts }),
    });
    if (!response.ok) return texts.map(() => null);
    const data = await response.json() as { embeddings: number[][] };
    return (data.embeddings ?? []).map(e => e ? new Float32Array(e) : null);
  } catch {
    logger.debug('[RAG] Ollama batch embedding unavailable');
    return texts.map(() => null);
  }
}

/** Cosine similarity between two Float32Arrays */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Serialize Float32Array to Buffer for SQLite BLOB storage */
export function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/** Deserialize Buffer from SQLite BLOB to Float32Array */
export function deserializeEmbedding(buffer: Buffer): Float32Array {
  const ab = new ArrayBuffer(buffer.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buffer.length; i++) view[i] = buffer[i];
  return new Float32Array(ab);
}
