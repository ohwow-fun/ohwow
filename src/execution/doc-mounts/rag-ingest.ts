/**
 * RAG Ingestion for Doc Mounts
 *
 * Chunks and embeds mounted documentation pages into the knowledge base
 * for semantic search. Reuses the existing RAG pipeline (chunker, embeddings,
 * corpus stats) and knowledge base tables.
 */

import { createHash } from 'crypto';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { DocMount, DocMountPage } from './types.js';
import { chunkText, type Chunk } from '../../lib/rag/chunker.js';
import { generateEmbeddings, serializeEmbedding } from '../../lib/rag/embeddings.js';
import { tokenize } from '../../lib/rag/retrieval.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface RagIngestOptions {
  db: DatabaseAdapter;
  workspaceId: string;
  ollamaUrl?: string;
  embeddingModel?: string;
}

// ============================================================================
// MAIN API
// ============================================================================

/**
 * Ingest all pages of a mounted doc site into the knowledge base.
 * Creates one knowledge_document per page, chunks it, and optionally embeds.
 *
 * Returns the list of created knowledge document IDs.
 */
export async function ingestMountToKnowledgeBase(
  mount: DocMount,
  pages: DocMountPage[],
  opts: RagIngestOptions,
): Promise<string[]> {
  const { db, workspaceId, ollamaUrl, embeddingModel } = opts;
  const docIds: string[] = [];

  logger.info(
    { url: mount.url, pageCount: pages.length },
    '[doc-mount-rag] Starting knowledge base ingestion',
  );

  for (const page of pages) {
    try {
      const docId = createDocId(mount.id, page.filePath);

      // Create knowledge document
      const { error: insertError } = await db
        .from('agent_workforce_knowledge_documents')
        .insert({
          id: docId,
          workspace_id: workspaceId,
          agent_id: null, // Workspace-wide
          title: titleFromPath(page.filePath, mount.domain),
          description: `Documentation page from ${mount.url}`,
          filename: page.filePath.replace(/^\//, ''),
          file_type: '.md',
          file_size: page.byteSize,
          storage_path: `doc-mount://${mount.namespace}${page.filePath}`,
          source_type: 'url',
          source_url: page.sourceUrl,
          processing_status: 'processing',
        });

      if (insertError) {
        // Likely duplicate — skip
        logger.debug({ docId, error: insertError.message }, '[doc-mount-rag] Skipping existing doc');
        continue;
      }

      // Chunk the page content
      const chunks = chunkText(page.content);
      if (chunks.length === 0) continue;

      // Insert chunks
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkId = createHash('sha256').update(`${docId}-${i}`).digest('hex').slice(0, 32);
        await db
          .from('agent_workforce_knowledge_chunks')
          .insert({
            id: chunkId,
            document_id: docId,
            workspace_id: workspaceId,
            chunk_index: i,
            content: chunk.content,
            token_count: chunk.tokenCount,
            keywords: JSON.stringify(chunk.keywords),
          });
      }

      // Generate embeddings if Ollama is available
      let usedModel: string | undefined;
      if (ollamaUrl && embeddingModel) {
        usedModel = await embedDocChunks(db, docId, chunks, ollamaUrl, embeddingModel);
      }

      // Update corpus stats
      await updateCorpusStatsForChunks(db, workspaceId, chunks, 1);

      // Mark document as ready
      const contentHash = createHash('sha256').update(page.content).digest('hex').slice(0, 16);
      await db
        .from('agent_workforce_knowledge_documents')
        .update({
          processing_status: 'ready',
          processed_at: new Date().toISOString(),
          compiled_text: page.content,
          compiled_token_count: page.tokenCount,
          chunk_count: chunks.length,
          content_hash: contentHash,
          ...(usedModel ? { embedding_model: usedModel } : {}),
        })
        .eq('id', docId);

      docIds.push(docId);
    } catch (err) {
      logger.warn(
        { err, filePath: page.filePath },
        '[doc-mount-rag] Failed to ingest page, continuing',
      );
    }
  }

  logger.info(
    { url: mount.url, ingested: docIds.length, total: pages.length },
    '[doc-mount-rag] Ingestion complete',
  );

  return docIds;
}

/**
 * Remove all knowledge documents created from a doc mount.
 * Called during unmount to clean up.
 *
 * Uses the namespace-based storage_path prefix to identify docs
 * belonging to this mount: "doc-mount://{namespace}/..."
 */
export async function removeKnowledgeForMount(
  namespace: string,
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<number> {
  const prefix = `doc-mount://${namespace}/`;

  // Fetch all doc-mount knowledge docs for this workspace
  // Filter by storage_path prefix in JS (DatabaseAdapter lacks LIKE)
  const { data: allDocs } = await db
    .from('agent_workforce_knowledge_documents')
    .select('id, storage_path')
    .eq('workspace_id', workspaceId)
    .eq('source_type', 'url');

  if (!allDocs || allDocs.length === 0) return 0;

  // Filter to only docs from this specific mount's namespace
  const mountDocs = (allDocs as Array<{ id: string; storage_path: string }>)
    .filter((d) => d.storage_path?.startsWith(prefix));

  if (mountDocs.length === 0) return 0;

  let removed = 0;
  for (const doc of mountDocs) {
    // Get chunks for corpus stats update before deleting
    const { data: chunks } = await db
      .from('agent_workforce_knowledge_chunks')
      .select('content')
      .eq('document_id', doc.id);

    if (chunks && chunks.length > 0) {
      const chunkData = (chunks as Array<{ content: string }>).map((c) => ({
        content: c.content,
      }));
      await updateCorpusStatsForChunks(db, workspaceId, chunkData, -1);
    }

    // Delete document (chunks cascade)
    await db
      .from('agent_workforce_knowledge_documents')
      .delete()
      .eq('id', doc.id);
    removed++;
  }

  return removed;
}

// ============================================================================
// HELPERS
// ============================================================================

/** Create a deterministic document ID from mount + path */
function createDocId(mountId: string, filePath: string): string {
  return createHash('sha256').update(`doc-mount:${mountId}:${filePath}`).digest('hex').slice(0, 32);
}

/** Extract a readable title from a file path */
function titleFromPath(filePath: string, domain: string): string {
  const name = filePath
    .replace(/^\//, '')
    .replace(/\.md$/, '')
    .replace(/\//g, ' > ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return `${domain}: ${name || 'Index'}`;
}

/** Generate and store embeddings for chunks */
async function embedDocChunks(
  db: DatabaseAdapter,
  docId: string,
  chunks: Chunk[],
  ollamaUrl: string,
  embeddingModel: string,
): Promise<string | undefined> {
  try {
    const texts = chunks.map((c) => c.content);
    const embeddings = await generateEmbeddings(texts, ollamaUrl, embeddingModel);
    let count = 0;
    for (let i = 0; i < chunks.length; i++) {
      const emb = embeddings[i];
      if (emb) {
        const chunkId = createHash('sha256').update(`${docId}-${i}`).digest('hex').slice(0, 32);
        await db
          .from('agent_workforce_knowledge_chunks')
          .update({ embedding: serializeEmbedding(emb) })
          .eq('id', chunkId);
        count++;
      }
    }
    return count > 0 ? embeddingModel : undefined;
  } catch (err) {
    logger.warn({ err }, '[doc-mount-rag] Embedding generation failed, continuing without');
    return undefined;
  }
}

/** Update corpus stats for IDF scoring */
async function updateCorpusStatsForChunks(
  db: DatabaseAdapter,
  workspaceId: string,
  chunks: Array<{ content: string }>,
  delta: 1 | -1,
): Promise<void> {
  try {
    const docTerms = new Set<string>();
    for (const chunk of chunks) {
      for (const t of tokenize(chunk.content)) {
        docTerms.add(t);
      }
    }

    const terms = [...docTerms];
    if (terms.length === 0) return;

    const { data: existingRows } = await db
      .from<{ term: string; doc_frequency: number }>('rag_corpus_stats')
      .select('term, doc_frequency')
      .eq('workspace_id', workspaceId)
      .in('term', terms);

    const existingMap = new Map<string, number>();
    for (const row of existingRows ?? []) {
      existingMap.set(row.term, row.doc_frequency);
    }

    for (const term of terms) {
      const current = existingMap.get(term);
      if (current !== undefined) {
        const newFreq = Math.max(0, current + delta);
        await db
          .from('rag_corpus_stats')
          .update({ doc_frequency: newFreq })
          .eq('workspace_id', workspaceId)
          .eq('term', term);
      } else if (delta > 0) {
        await db
          .from('rag_corpus_stats')
          .insert({ workspace_id: workspaceId, term, doc_frequency: 1 });
      }
    }
  } catch {
    // Non-critical — IDF stats are a scoring optimization
  }
}
