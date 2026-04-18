/**
 * Embedding Routes
 *
 * Thin HTTP layer over the process-wide in-daemon embedder (see
 * src/embeddings/). Exposes POST /api/embed so MCP clients (and any other
 * local tool) can turn text into vectors without standing up a separate
 * Python/Modal service. Uses the shared embedder singleton so cold-load
 * (~30s on M-series) only happens once per daemon lifetime — and the
 * daemon start hook warms it before the first request anyway.
 *
 * Request body:
 *   {
 *     texts:       string[]    // non-empty, ≤ 256 entries, each non-empty
 *     is_query?:   boolean     // enable asymmetric query encoding
 *     instruction?: string     // Qwen3-style task instruction (query side)
 *   }
 *
 * Response:
 *   {
 *     model:      string       // e.g. onnx-community/Qwen3-Embedding-0.6B-ONNX
 *     dim:        number       // 1024 for Qwen3-Embedding-0.6B
 *     count:      number       // same as texts.length
 *     vectors:    number[][]   // L2-normalized float vectors
 *     latency_ms: number       // encode time only; excludes cold-load wait
 *   }
 *
 * Not yet wired into retrieval — KnowledgeStore still uses BM25 + Ollama
 * embeddings. This endpoint is the building block for the upcoming in-daemon
 * semantic search migration.
 */

import { Router } from 'express';
import { getSharedEmbedder } from '../../embeddings/index.js';
import { logger } from '../../lib/logger.js';

const MAX_BATCH_SIZE = 256;

interface EmbedRequestBody {
  texts?: unknown;
  is_query?: unknown;
  instruction?: unknown;
}

/**
 * Convert a Float32Array into a plain number[] so JSON.stringify emits a
 * regular array. (Stringifying a typed array produces `{"0":0.1,"1":...}`
 * which is not what callers want.)
 */
function toPlainArray(vec: Float32Array): number[] {
  const out = new Array<number>(vec.length);
  for (let i = 0; i < vec.length; i += 1) {
    out[i] = vec[i];
  }
  return out;
}

export function createEmbedRouter(): Router {
  const router = Router();

  router.post('/api/embed', async (req, res) => {
    const body = (req.body ?? {}) as EmbedRequestBody;
    const { texts, is_query, instruction } = body;

    if (!Array.isArray(texts) || texts.length === 0) {
      res.status(400).json({ error: '`texts` must be a non-empty array of strings.' });
      return;
    }
    if (texts.length > MAX_BATCH_SIZE) {
      res.status(400).json({
        error: `Too many texts: got ${texts.length}, max ${MAX_BATCH_SIZE} per call.`,
      });
      return;
    }
    for (let i = 0; i < texts.length; i += 1) {
      const t = texts[i];
      if (typeof t !== 'string' || t.length === 0) {
        res.status(400).json({
          error: `texts[${i}] must be a non-empty string.`,
        });
        return;
      }
    }
    if (is_query !== undefined && typeof is_query !== 'boolean') {
      res.status(400).json({ error: '`is_query` must be a boolean when provided.' });
      return;
    }
    if (instruction !== undefined && typeof instruction !== 'string') {
      res.status(400).json({ error: '`instruction` must be a string when provided.' });
      return;
    }

    try {
      const embedder = getSharedEmbedder();
      // Wait for weights if the warmup hook hasn't finished (or failed).
      // This call is a no-op once warm.
      await embedder.ready();

      const encodeStartedAt = Date.now();
      const vectors = await embedder.embed(texts as string[], {
        isQuery: is_query === true,
        instruction: typeof instruction === 'string' ? instruction : null,
      });
      const latencyMs = Date.now() - encodeStartedAt;

      res.json({
        model: embedder.modelId,
        dim: embedder.dim,
        count: vectors.length,
        vectors: vectors.map(toPlainArray),
        latency_ms: latencyMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err: message }, '[embed] route failed');
      res.status(500).json({ error: `Embedding failed: ${message}` });
    }
  });

  return router;
}
