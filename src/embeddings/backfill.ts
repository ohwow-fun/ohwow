/**
 * Embedding backfill: one-shot boot-time worker that fills in Qwen3
 * embeddings for any knowledge chunk that either has no vector or was
 * embedded by a different model.
 *
 * Why a backfill step exists at all: the daemon already had 425 chunks
 * on disk before the in-daemon Qwen3 embedder shipped. Those rows have
 * NULL `embedding` blobs. The document-worker will embed new uploads
 * going forward, but retrieval still needs vectors for the historical
 * corpus before hybrid search becomes useful. Running this at boot (after
 * warmSharedEmbedder) lets the daemon catch up in a single pass without
 * a separate CLI command.
 *
 * Idempotency: skips any row whose `embedding_model` already matches
 * the live embedder's modelId. Safe to re-run on every start; once
 * caught up the pass becomes a single COUNT-returns-zero query.
 *
 * Non-fatal: failures only log at warn. A broken HF cache or out-of-
 * memory moment should never block the daemon.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { Embedder } from './model.js';
import type { Logger } from 'pino';
import { serializeEmbedding } from '../lib/rag/embeddings.js';

export interface BackfillOptions {
  db: DatabaseAdapter;
  embedder: Embedder;
  /** Rows embedded per Qwen3 forward pass. 32 is a good M-series default. */
  batchSize?: number;
  /** Rows fetched per SELECT page. Kept small so the scan pauses between
   *  pages and lets the event loop service HTTP requests. */
  pageSize?: number;
  logger: Logger;
}

interface ChunkRow {
  id: string;
  content: string;
  embedding_model: string | null;
}

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_PAGE_SIZE = 500;

/**
 * Scan knowledge chunks in pages and embed any row missing a Qwen3
 * vector. Blocking on the embedder's ready() before doing anything, so
 * this fn can be fired from daemon startup without coordinating with
 * the warmup hook.
 */
export async function runEmbeddingBackfill(opts: BackfillOptions): Promise<void> {
  const { db, embedder, logger } = opts;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;

  const startedAt = Date.now();
  await embedder.ready();
  const modelId = embedder.modelId;

  let totalScanned = 0;
  let totalEmbedded = 0;
  let totalFailed = 0;

  // Outer loop: keep pulling pages until a page returns zero new work.
  // Ordered by created_at so the oldest chunks (pre-Qwen3) land first
  // and a crash mid-scan picks up roughly where it left off.
  while (true) {
    const { data, error } = await db
      .from<ChunkRow & { created_at: string }>('agent_workforce_knowledge_chunks')
      .select('id, content, embedding_model, created_at')
      .order('created_at', { ascending: true })
      .limit(pageSize);

    if (error) {
      logger.warn({ err: error }, '[embeddings.backfill] page query failed, aborting');
      return;
    }
    if (!data || data.length === 0) break;

    // Filter to rows that still need this modelId. Done in JS because
    // the adapter's builder doesn't expose "OR IS NULL" conditions.
    const needsEmbed = data.filter(
      (row) => row.embedding_model !== modelId,
    );

    totalScanned += data.length;

    if (needsEmbed.length === 0) {
      // Everything in this page is up-to-date. Since we ordered by
      // created_at ASC, newer pages are even more likely to be up-to-
      // date, so we can stop here.
      break;
    }

    // Inner loop: embed in fixed-size batches so a single page of 500
    // doesn't pin the GPU for one enormous forward pass.
    for (let offset = 0; offset < needsEmbed.length; offset += batchSize) {
      const batch = needsEmbed.slice(offset, offset + batchSize);
      const texts = batch.map((r) => r.content);
      try {
        const vectors = await embedder.embed(texts);
        const nowIso = new Date().toISOString();
        for (let i = 0; i < batch.length; i++) {
          const vec = vectors[i];
          if (!vec) {
            totalFailed++;
            continue;
          }
          await db
            .from('agent_workforce_knowledge_chunks')
            .update({
              embedding: serializeEmbedding(vec),
              embedding_model: modelId,
              embedding_updated_at: nowIso,
            })
            .eq('id', batch[i].id);
          totalEmbedded++;
        }
      } catch (err) {
        totalFailed += batch.length;
        logger.warn(
          { err, batchStart: offset, batchSize: batch.length },
          '[embeddings.backfill] batch embed failed, continuing',
        );
      }
      // Yield to the event loop between batches so HTTP / scheduler work
      // doesn't starve while we backfill.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // If the page was smaller than pageSize we've reached the end.
    if (data.length < pageSize) break;
  }

  const duration = Date.now() - startedAt;
  if (totalEmbedded > 0 || totalFailed > 0) {
    logger.info(
      {
        modelId,
        scanned: totalScanned,
        embedded: totalEmbedded,
        failed: totalFailed,
        duration_ms: duration,
      },
      '[embeddings.backfill] complete',
    );
  } else {
    logger.debug(
      { modelId, scanned: totalScanned, duration_ms: duration },
      '[embeddings.backfill] nothing to do',
    );
  }
}
