/**
 * Document Processing Worker
 *
 * Polls the document_processing_queue table and processes documents
 * in the background, keeping the orchestrator responsive. Follows
 * the same setInterval + start/stop pattern as HeartbeatCoordinator.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import { chunkText } from '../../lib/rag/chunker.js';
import { generateEmbeddings, serializeEmbedding } from '../../lib/rag/embeddings.js';
import { extractEntitiesAndRelations, saveGraphData } from '../../lib/rag/knowledge-graph.js';
import { extractTextLocal, updateCorpusStats } from '../../orchestrator/tools/knowledge.js';
import { logger } from '../../lib/logger.js';

const TICK_INTERVAL_MS = 5_000; // Poll every 5 seconds

interface QueueJob {
  id: string;
  workspace_id: string;
  document_id: string;
  status: string;
  payload: string;
}

interface DocumentRow {
  id: string;
  title: string;
  filename: string;
  file_type: string;
  storage_path: string;
  source_type: string;
  compiled_text: string | null;
}

interface LocalChunk {
  content: string;
  tokenCount: number;
  keywords: string[];
}

export class DocumentWorker {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private processing = false;

  constructor(
    private db: DatabaseAdapter,
    private bus: TypedEventBus<RuntimeEvents>,
    private config: { ollamaUrl?: string; embeddingModel?: string; ollamaModel?: string },
  ) {}

  /**
   * Start polling for pending document processing jobs.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('[DocumentWorker] Starting');

    this.tickTimer = setInterval(() => {
      this.tick().catch((err) => {
        logger.error({ err }, '[DocumentWorker] Tick error');
      });
    }, TICK_INTERVAL_MS);
  }

  /**
   * Stop the worker.
   */
  stop(): void {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    logger.info('[DocumentWorker] Stopped');
  }

  /**
   * Check for and process the oldest pending job.
   */
  async tick(): Promise<void> {
    if (!this.running || this.processing) return;

    try {
      this.processing = true;

      // 1. Find oldest pending job
      const { data: jobs } = await this.db
        .from<QueueJob>('document_processing_queue')
        .select('id, workspace_id, document_id, status, payload')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1);

      if (!jobs || jobs.length === 0) return;

      const job = jobs[0];
      await this.processJob(job);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process a single queue job end-to-end.
   */
  private async processJob(job: QueueJob): Promise<void> {
    const now = new Date().toISOString();

    // 2. Mark as processing
    await this.db
      .from('document_processing_queue')
      .update({ status: 'processing', started_at: now })
      .eq('id', job.id);

    // 3. Load document record
    const { data: doc } = await this.db
      .from<DocumentRow>('agent_workforce_knowledge_documents')
      .select('id, title, filename, file_type, storage_path, source_type, compiled_text')
      .eq('id', job.document_id)
      .single();

    if (!doc) {
      await this.failJob(job.id, job.document_id, 'Document record not found');
      return;
    }

    this.bus.emit('knowledge:processing', {
      documentId: job.document_id,
      status: 'started',
      title: doc.title,
    });

    try {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(job.payload);
      } catch {
        payload = {};
      }

      // 4. Extract text based on source type
      let text: string | null = null;
      const sourceType = (payload.source_type as string) || doc.source_type;

      if (sourceType === 'upload') {
        const filePath = (payload.file_path as string) || doc.storage_path?.replace('local://', '');
        if (!filePath) {
          await this.failJob(job.id, job.document_id, 'No file path available');
          return;
        }
        const buffer = await readFile(filePath);
        const ext = extname(filePath).toLowerCase();
        text = await extractTextLocal(buffer, ext, doc.filename);
      } else if (sourceType === 'url') {
        // URL documents should have compiled_text stored during scraping
        text = doc.compiled_text;
      } else if (sourceType === 'connector') {
        text = (payload.content as string) || doc.compiled_text;
      } else {
        // Generic fallback: any source that pre-populated compiled_text
        // on insert (e.g. 'arxiv', 'self-observation' from
        // knowledge-ingest.ts) is valid to process without needing a
        // dedicated branch. The chunk/embed pipeline doesn't care where
        // the text came from — only that it exists and is non-empty.
        // Matches the contract knowledge-ingest.ts already assumes:
        // "hand the worker compiled_text, it chunks + embeds."
        text = doc.compiled_text;
      }

      if (!text || text.trim().length === 0) {
        await this.failJob(job.id, job.document_id, 'No text could be extracted.');
        return;
      }

      // 5. Chunk text
      const chunks: LocalChunk[] = chunkText(text).map((c) => ({
        content: c.content,
        tokenCount: c.tokenCount,
        keywords: c.keywords,
      }));

      const contentHash = createHash('sha256').update(text).digest('hex').slice(0, 16);

      // 6. Save chunks
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkId = createHash('sha256').update(`${job.document_id}-${i}`).digest('hex').slice(0, 32);
        await this.db
          .from('agent_workforce_knowledge_chunks')
          .insert({
            id: chunkId,
            document_id: job.document_id,
            workspace_id: job.workspace_id,
            chunk_index: i,
            content: chunk.content,
            token_count: chunk.tokenCount,
            keywords: JSON.stringify(chunk.keywords),
          });
      }

      // 7. Update corpus stats
      await updateCorpusStats(this.db, job.workspace_id, chunks, 1);

      // 8. Generate embeddings if available
      let embeddingModel: string | undefined;
      if (this.config.ollamaUrl && this.config.embeddingModel) {
        try {
          const chunkTexts = chunks.map((c) => c.content);
          const embeddings = await generateEmbeddings(chunkTexts, this.config.ollamaUrl, this.config.embeddingModel);
          let embeddedCount = 0;
          for (let i = 0; i < chunks.length; i++) {
            const emb = embeddings[i];
            if (emb) {
              const chunkId = createHash('sha256').update(`${job.document_id}-${i}`).digest('hex').slice(0, 32);
              await this.db
                .from('agent_workforce_knowledge_chunks')
                .update({ embedding: serializeEmbedding(emb) })
                .eq('id', chunkId);
              embeddedCount++;
            }
          }
          if (embeddedCount > 0) embeddingModel = this.config.embeddingModel;
        } catch (err) {
          logger.warn({ err, documentId: job.document_id }, '[DocumentWorker] Embedding generation failed, continuing without embeddings');
        }
      }

      // 8b. Extract knowledge graph (best-effort, don't fail the job)
      // Process in parallel batches of KG_CONCURRENCY to cut wall-clock time.
      if (this.config.ollamaUrl && this.config.ollamaModel) {
        const KG_CONCURRENCY = 3;
        for (let i = 0; i < chunks.length; i += KG_CONCURRENCY) {
          const batch = chunks.slice(i, i + KG_CONCURRENCY);
          await Promise.allSettled(batch.map(async (chunk, j) => {
            const idx = i + j;
            const chunkId = createHash('sha256').update(`${job.document_id}-${idx}`).digest('hex').slice(0, 32);
            try {
              const extraction = await extractEntitiesAndRelations(
                chunk.content,
                this.config.ollamaUrl!,
                this.config.ollamaModel!,
              );
              if (extraction.entities.length > 0 || extraction.relations.length > 0) {
                await saveGraphData(this.db, job.workspace_id, chunkId, extraction);
              }
            } catch {
              // Skip — graph extraction is best-effort
            }
          }));
        }
      }

      // 9. Update document status to ready
      await this.db
        .from('agent_workforce_knowledge_documents')
        .update({
          processing_status: 'ready',
          processed_at: new Date().toISOString(),
          compiled_text: text,
          compiled_token_count: Math.ceil(text.length / 4),
          chunk_count: chunks.length,
          content_hash: contentHash,
          ...(embeddingModel ? { embedding_model: embeddingModel } : {}),
        })
        .eq('id', job.document_id);

      // 10. Mark queue job as done
      await this.db
        .from('document_processing_queue')
        .update({ status: 'done', completed_at: new Date().toISOString() })
        .eq('id', job.id);

      // 11. Emit completion event
      this.bus.emit('knowledge:processing', {
        documentId: job.document_id,
        status: 'completed',
        title: doc.title,
      });

      logger.info(
        { documentId: job.document_id, chunks: chunks.length, title: doc.title },
        '[DocumentWorker] Document processed successfully',
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Processing failed';
      await this.failJob(job.id, job.document_id, errorMsg);
    }
  }

  /**
   * Mark a job and its document as failed.
   */
  private async failJob(jobId: string, documentId: string, error: string): Promise<void> {
    logger.error({ documentId, error }, '[DocumentWorker] Document processing failed');

    await this.db
      .from('document_processing_queue')
      .update({ status: 'failed', completed_at: new Date().toISOString(), error })
      .eq('id', jobId);

    await this.db
      .from('agent_workforce_knowledge_documents')
      .update({ processing_status: 'failed', processing_error: error })
      .eq('id', documentId);

    this.bus.emit('knowledge:processing', {
      documentId,
      status: 'failed',
      error,
    });
  }
}
