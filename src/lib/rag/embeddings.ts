/**
 * RAG Embeddings — storage + similarity helpers.
 *
 * Embedding GENERATION now lives in `src/embeddings/` and runs on the
 * in-daemon Qwen3-ONNX embedder (L2-normalized 1024-dim vectors). This
 * module only carries the thin utilities the retrieval + document
 * pipelines share: buffer round-tripping and cosine similarity.
 */

/** Cosine similarity between two Float32Arrays.
 *
 * Qwen3 outputs are L2-normalized at embed time, so for Qwen3 vectors
 * this reduces to a dot product. Keep the full formula anyway so the
 * helper stays correct when mixed with non-normalized vectors. */
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
