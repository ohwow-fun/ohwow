/**
 * Thin helper to push research + self-observation findings into the
 * local knowledge base so the KB's BM25 + semantic search surfaces
 * them later (e.g. Rule 5 of experiment-proposal-generator).
 *
 * Design notes:
 *   - Dedupes on source_url. A paper that was ingested yesterday is
 *     not re-inserted today — we get an early return with
 *     `{ inserted: false, reason: 'duplicate' }` so the caller can
 *     still treat it as a success.
 *   - Delegates chunking + embedding to the DocumentWorker by
 *     enqueuing the document. That keeps this helper synchronous
 *     (single DB insert + queue insert) and avoids pulling in the
 *     Ollama embedding client here.
 *   - source_type is a short slug ('arxiv', 'self-observation') the
 *     caller picks. Filter by it to separate the KB into corpuses.
 */

import { createHash } from 'node:crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { enqueueDocument } from '../orchestrator/tools/knowledge.js';
import { logger } from '../lib/logger.js';

export interface IngestInput {
  workspaceId: string;
  title: string;
  text: string;
  sourceType: string;
  sourceUrl: string;
  /** Optional description for the documents table. Defaults to a slugified source_type prefix. */
  description?: string;
}

export type IngestResult =
  | { inserted: true; document_id: string }
  | { inserted: false; reason: 'duplicate' | 'text_too_short' | 'db_error'; error?: string };

const MIN_TEXT_BYTES = 80;

export async function ingestKnowledgeText(
  db: DatabaseAdapter,
  input: IngestInput,
): Promise<IngestResult> {
  const text = input.text.trim();
  if (Buffer.byteLength(text, 'utf-8') < MIN_TEXT_BYTES) {
    return { inserted: false, reason: 'text_too_short' };
  }

  // Dedup on (workspace, source_url) so the same paper + workspace
  // doesn't produce N copies. We explicitly want "same paper in a
  // different workspace" to be a separate row, so workspace_id is
  // part of the key.
  const { data: existing } = await db
    .from<{ id: string }>('agent_workforce_knowledge_documents')
    .select('id')
    .eq('workspace_id', input.workspaceId)
    .eq('source_url', input.sourceUrl)
    .limit(1);
  if (existing && existing.length > 0) {
    return { inserted: false, reason: 'duplicate' };
  }

  const docId = createHash('sha256')
    .update(`${Date.now()}-${input.sourceUrl}`)
    .digest('hex')
    .slice(0, 32);
  const filename = `${input.sourceType}-${docId.slice(0, 8)}.txt`;
  const description = input.description ?? `Ingested from ${input.sourceType}`;

  const { error } = await db
    .from('agent_workforce_knowledge_documents')
    .insert({
      id: docId,
      workspace_id: input.workspaceId,
      agent_id: null,
      title: input.title,
      description,
      filename,
      file_type: '.txt',
      file_size: Buffer.byteLength(text, 'utf-8'),
      storage_path: `inline://${input.sourceType}/${docId}`,
      source_type: input.sourceType,
      source_url: input.sourceUrl,
      processing_status: 'processing',
      compiled_text: text,
    });
  if (error) {
    logger.debug({ err: error.message, source: input.sourceUrl }, '[knowledge-ingest] insert failed');
    return { inserted: false, reason: 'db_error', error: error.message };
  }

  try {
    await enqueueDocument(db, input.workspaceId, docId, {
      source_type: input.sourceType,
      url: input.sourceUrl,
    });
  } catch (err) {
    // Document row is written; worker will retry when queue is
    // reprocessed. Not worth rolling back the insert for a transient
    // queue hiccup.
    logger.debug({ err }, '[knowledge-ingest] enqueue failed, doc still persisted');
  }

  return { inserted: true, document_id: docId };
}
