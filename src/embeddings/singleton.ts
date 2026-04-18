/**
 * Shared embedder singleton for the daemon process.
 *
 * createEmbedder() allocates a new TransformersJS model worker every time it's
 * called. That's fine for one-off scripts (benchmarks, evals), but inside the
 * daemon we want a single model instance shared by the warmup hook, the HTTP
 * route, and any future in-process consumers (RAG search, KB indexer). This
 * module holds that single instance and exposes two helpers:
 *
 *   getSharedEmbedder()   — lazy construct + return the Embedder. Never
 *                           downloads weights on its own; call ready() when
 *                           you need them loaded.
 *   warmSharedEmbedder()  — fire-and-forget warmup. Used by daemon startup
 *                           so the first user-facing embed() call hits warm
 *                           instead of paying the ~30s ONNX cold load.
 *
 * Thread-safety: Node is single-threaded, and createEmbedder() + ready() are
 * both idempotent (ready() dedupes via an internal loadPromise). Multiple
 * concurrent calls to warm or embed during boot collapse onto the same
 * load promise automatically.
 */

import { createEmbedder } from './model.js';
import type { Embedder, EmbedderConfig } from './model.js';
import { logger } from '../lib/logger.js';

let shared: Embedder | null = null;
let warmupPromise: Promise<void> | null = null;

/**
 * Return the process-wide embedder. Constructs it on first call (no network
 * work yet — weights load lazily in ready()).
 */
export function getSharedEmbedder(config: EmbedderConfig = {}): Embedder {
  if (!shared) {
    shared = createEmbedder(config);
  }
  return shared;
}

/**
 * Kick off (or re-use) a background warmup that loads the ONNX weights.
 *
 * Safe to call from daemon startup after "ready" is logged — failures are
 * caught and demoted to a warn so a broken HF mirror or out-of-space cache
 * never crashes the daemon. The HTTP route still awaits ready() on its own,
 * so a failed warmup just means the first embed call pays the cold load
 * cost instead of hitting warm.
 */
export function warmSharedEmbedder(config: EmbedderConfig = {}): Promise<void> {
  if (warmupPromise) return warmupPromise;
  const embedder = getSharedEmbedder(config);
  const startedAt = Date.now();
  logger.info({ modelId: embedder.modelId }, '[embeddings] warmup starting');
  warmupPromise = embedder
    .ready()
    .then(async () => {
      const readyAt = Date.now();
      // ready() loads weights, but TransformersJS defers tokenizer init and
      // ONNX graph compilation to the first actual embed call. Run a
      // throwaway encode so the first user request hits an already-JIT'd
      // hot path instead of paying ~20s on top of weight load.
      await embedder.embed(['warmup']);
      logger.info(
        {
          modelId: embedder.modelId,
          dim: embedder.dim,
          ready_ms: readyAt - startedAt,
          first_embed_ms: Date.now() - readyAt,
          duration_ms: Date.now() - startedAt,
        },
        '[embeddings] warmup complete',
      );
    })
    .catch((err) => {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          duration_ms: Date.now() - startedAt,
        },
        '[embeddings] warmup failed (non-fatal; first call will cold-load)',
      );
      // Reset so a later call can retry.
      warmupPromise = null;
    });
  return warmupPromise;
}

/**
 * Test-only reset. Drops the shared instance and any in-flight warmup so a
 * subsequent getSharedEmbedder() constructs a fresh model.
 */
export function resetSharedEmbedderForTests(): void {
  shared = null;
  warmupPromise = null;
}
