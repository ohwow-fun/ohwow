/**
 * Orchestrator Tools — Knowledge Base
 * Local runtime handlers for knowledge document management.
 *
 * Upload and delete paths fire a best-effort upstream sync via the control
 * plane so cloud agents see the same knowledge corpus. Sync failures
 * never block the local write.
 */

import type { LocalToolContext } from '../local-tool-types.js';
import type { ToolResult } from '../local-tool-types.js';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { retrieveKnowledgeChunks, tokenize } from '../../lib/rag/retrieval.js';
import { generateEmbeddings, serializeEmbedding } from '../../lib/rag/embeddings.js';
import { chunkText } from '../../lib/rag/chunker.js';
import { logger } from '../../lib/logger.js';

/** Fire-and-forget upstream knowledge-doc sync. Never throws. */
async function syncKnowledgeUpstream(
  ctx: LocalToolContext,
  action: 'upsert' | 'delete',
  payload: Record<string, unknown> & { id: string },
): Promise<void> {
  if (!ctx.controlPlane) return;
  try {
    const result = await ctx.controlPlane.reportResource('knowledge_document', action, payload);
    if (!result.ok) {
      logger.debug({ action, id: payload.id, error: result.error }, '[knowledge] cloud sync deferred');
    }
  } catch (err) {
    logger.warn({ err, action, id: payload.id }, '[knowledge] cloud sync threw');
  }
}

// ============================================================================
// ENQUEUE DOCUMENT FOR BACKGROUND PROCESSING
// ============================================================================

const ENQUEUE_THRESHOLD_BYTES = 50_000; // 50KB

export async function enqueueDocument(
  db: import('../../db/adapter-types.js').DatabaseAdapter,
  workspaceId: string,
  documentId: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const jobId = createHash('sha256').update(`${Date.now()}-${documentId}`).digest('hex').slice(0, 32);

  await db.from('document_processing_queue').insert({
    id: jobId,
    workspace_id: workspaceId,
    document_id: documentId,
    status: 'pending',
    payload: JSON.stringify(payload),
  });

  // Return queue position (count of pending jobs)
  const { data } = await db
    .from<{ id: string }>('document_processing_queue')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('status', 'pending');

  return data?.length ?? 1;
}

// ============================================================================
// LIST KNOWLEDGE
// ============================================================================

/**
 * Fetch a single knowledge document in its entirety, with a resolution
 * cascade that handles exact ids, exact titles, fuzzy title substrings,
 * and semantic matches via the existing chunk-retrieval embeddings.
 *
 * Fills a real gap in RAG workflows: `search_knowledge` only returns
 * similarity-ranked fragments, so when an agent wants to follow a specific
 * playbook or reference end-to-end it needs the whole thing. Without this
 * tool, agents end up guessing procedure details and hitting real failures
 * (wrong file paths, wrong table names, missed red-flag patterns) because
 * they never saw the full doc.
 *
 * Resolution order:
 *   1. `document_id` exact match
 *   2. `title` exact match (case-insensitive, whitespace-normalized)
 *   3. `title` substring match (case-insensitive) — returns the longest-
 *      matching title, with a `matchType` hint so callers know it's fuzzy
 *   4. `query` (or `title` when no exact match) → semantic search via the
 *      existing chunk retriever. The document whose chunks score highest
 *      wins. Returns full content plus confidence + alternatives so the
 *      caller can decide whether to trust the match or ask for clarification
 *
 * The cascade means an agent can ask for "ops playbook" or "monitoring
 * guide" and land on "Ops Monitoring Playbook" without knowing the exact
 * id or title.
 */
export async function getKnowledgeDocument(
  ctx: LocalToolContext,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const id = typeof input.document_id === 'string' ? input.document_id.trim() : '';
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const freeQuery = typeof input.query === 'string' ? input.query.trim() : '';

  if (!id && !title && !freeQuery) {
    return {
      success: false,
      error: 'Provide one of: document_id, title, or query. Use list_knowledge or search_knowledge to discover docs.',
    };
  }

  const FULL_SELECT =
    'id, title, filename, file_type, file_size, source_type, compiled_text, compiled_token_count, chunk_count, processing_status, created_at, processed_at, content_hash';

  /** Load a full document row by id. Returns null on miss. */
  const loadById = async (docId: string) => {
    const { data } = await ctx.db
      .from('agent_workforce_knowledge_documents')
      .select(FULL_SELECT)
      .eq('workspace_id', ctx.workspaceId)
      .eq('is_active', 1)
      .eq('id', docId)
      .maybeSingle();
    return data as Record<string, unknown> | null;
  };

  /** Shape a row into the tool result payload. */
  const shape = (
    row: Record<string, unknown>,
    matchType: 'id' | 'exact_title' | 'substring_title' | 'semantic',
    confidence: number,
    alternatives: Array<{ id: string; title: string; score: number }> = [],
  ) => ({
    success: true as const,
    data: {
      id: row.id,
      title: row.title,
      filename: row.filename,
      fileType: row.file_type,
      fileSize: row.file_size,
      source: row.source_type,
      status: row.processing_status,
      chunks: row.chunk_count,
      tokens: row.compiled_token_count,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      processedAt: row.processed_at,
      matchType,
      confidence,
      alternatives: alternatives.length > 0 ? alternatives : undefined,
      content: (row.compiled_text as string) || '',
    },
  });

  // 1. Exact id match — highest confidence.
  if (id) {
    const row = await loadById(id);
    if (row) return shape(row, 'id', 1.0);
    return {
      success: false,
      error: `No knowledge document found with id "${id}". Use list_knowledge to see available doc ids.`,
    };
  }

  // Load the full title index once — we use it for exact, substring, AND
  // to enrich alternatives from semantic matches.
  const { data: indexRows } = await ctx.db
    .from<{ id: string; title: string }>('agent_workforce_knowledge_documents')
    .select('id, title')
    .eq('workspace_id', ctx.workspaceId)
    .eq('is_active', 1);
  const allDocs = (indexRows ?? []) as Array<{ id: string; title: string }>;

  if (allDocs.length === 0) {
    return { success: false, error: 'Knowledge base is empty.' };
  }

  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

  // 2. Exact title match (case-insensitive, whitespace-normalized).
  if (title) {
    const normTitle = normalize(title);
    const exact = allDocs.find((d) => normalize(d.title) === normTitle);
    if (exact) {
      const row = await loadById(exact.id);
      if (row) return shape(row, 'exact_title', 1.0);
    }

    // 3. Substring title match — returns the longest title that contains
    // the query (or that the query contains). Bidirectional so "ops" finds
    // "Ops Monitoring Playbook" AND "monitoring playbook" finds it too.
    const substrMatches = allDocs
      .map((d) => {
        const dn = normalize(d.title);
        if (dn.includes(normTitle) || normTitle.includes(dn)) {
          // Rank by length of the shorter side — longer overlap wins.
          const overlap = Math.min(dn.length, normTitle.length);
          return { doc: d, overlap };
        }
        return null;
      })
      .filter((x): x is { doc: { id: string; title: string }; overlap: number } => x !== null)
      .sort((a, b) => b.overlap - a.overlap);

    if (substrMatches.length > 0) {
      const best = substrMatches[0].doc;
      const row = await loadById(best.id);
      if (row) {
        const alternatives = substrMatches.slice(1, 4).map((m) => ({
          id: m.doc.id,
          title: m.doc.title,
          score: Math.round((m.overlap / normTitle.length) * 100) / 100,
        }));
        return shape(row, 'substring_title', 0.85, alternatives);
      }
    }
  }

  // 4. Semantic fallback: run the given query (or the raw title if no
  // query) through the chunk retriever. The parent document of the
  // highest-scoring chunk wins. Alternatives list the runner-up docs with
  // their scores so callers can detect ambiguous matches.
  const semanticQuery = freeQuery || title;
  if (!semanticQuery) {
    return {
      success: false,
      error: 'Provide document_id, title, or query.',
    };
  }

  const chunks = await retrieveKnowledgeChunks({
    db: ctx.db,
    workspaceId: ctx.workspaceId,
    agentId: '__orchestrator__',
    query: semanticQuery,
    tokenBudget: 4000,
    maxChunks: 10,
    ollamaUrl: ctx.ollamaUrl,
    embeddingModel: ctx.embeddingModel,
    bm25Weight: ctx.ragBm25Weight,
    expandQueries: !!ctx.ollamaUrl,
    ollamaModel: ctx.ollamaModel,
    rerankerEnabled: ctx.rerankerEnabled,
    meshRagEnabled: ctx.meshRagEnabled,
  });

  if (chunks.length === 0) {
    return {
      success: false,
      error: `No knowledge document matched "${semanticQuery}" by id, title, or semantic search. Try list_knowledge to see what's available.`,
    };
  }

  // Aggregate chunk scores per document. The doc with the highest summed
  // top-chunk score wins. We use the title field from the chunk result
  // (which retrieveKnowledgeChunks includes) and resolve back to an id via
  // the title index.
  const scoresByTitle = new Map<string, number>();
  for (const c of chunks) {
    scoresByTitle.set(c.documentTitle, (scoresByTitle.get(c.documentTitle) ?? 0) + c.score);
  }
  const ranked = [...scoresByTitle.entries()]
    .map(([docTitle, score]) => {
      const match = allDocs.find((d) => d.title === docTitle);
      return match ? { id: match.id, title: docTitle, score } : null;
    })
    .filter((x): x is { id: string; title: string; score: number } => x !== null)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return {
      success: false,
      error: `Retrieved chunks but could not resolve them back to a known document. Try list_knowledge.`,
    };
  }

  const winner = ranked[0];
  const row = await loadById(winner.id);
  if (!row) {
    return {
      success: false,
      error: `Semantic match found doc "${winner.title}" but failed to load it. Try again or use list_knowledge.`,
    };
  }

  // Normalize confidence to 0-1: the winner's aggregate score divided by
  // itself is 1; we want a softer measure. Use the ratio of winner score
  // to total score as the confidence — close to 1 means the winner
  // dominates, close to 0 means results are split across many docs.
  const totalScore = ranked.reduce((sum, r) => sum + r.score, 0);
  const confidence = totalScore > 0
    ? Math.round((winner.score / totalScore) * 100) / 100
    : 0;

  const alternatives = ranked.slice(1, 4).map((r) => ({
    id: r.id,
    title: r.title,
    score: Math.round((r.score / (winner.score || 1)) * 100) / 100,
  }));

  return shape(row, 'semantic', confidence, alternatives);
}

export async function listKnowledge(
  ctx: LocalToolContext,
  input?: Record<string, unknown>
): Promise<ToolResult> {
  let query = ctx.db
    .from('agent_workforce_knowledge_documents')
    .select('id, title, filename, file_type, file_size, processing_status, chunk_count, compiled_token_count, agent_id, source_type, created_at')
    .eq('workspace_id', ctx.workspaceId)
    .eq('is_active', 1)
    .order('created_at', { ascending: false });

  if (input?.agent_id) {
    query = query.or(`agent_id.eq.${input.agent_id},agent_id.is.null`);
  }

  const { data, error } = await query;
  if (error) return { success: false, error: error.message };

  const docs = (data || []).map((d: Record<string, unknown>) => ({
    id: d.id,
    title: d.title,
    filename: d.filename,
    fileType: d.file_type,
    fileSize: d.file_size,
    status: d.processing_status,
    chunks: d.chunk_count,
    tokens: d.compiled_token_count,
    scope: d.agent_id ? `agent:${d.agent_id}` : 'workspace',
    source: d.source_type,
    createdAt: d.created_at,
  }));

  if (docs.length === 0) {
    return { success: true, data: { message: 'No knowledge base documents yet.', documents: [] } };
  }

  return { success: true, data: { documents: docs } };
}

// ============================================================================
// UPLOAD KNOWLEDGE (from local file path)
// ============================================================================

export async function uploadKnowledge(
  ctx: LocalToolContext,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const filePath = input.file_path as string;
  if (!filePath) return { success: false, error: 'file_path is required' };

  // Check file exists
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    return { success: false, error: `File not found: ${filePath}` };
  }

  if (!fileStats.isFile()) {
    return { success: false, error: `Not a file: ${filePath}` };
  }

  const maxSize = 50 * 1024 * 1024; // 50MB
  if (fileStats.size > maxSize) {
    return { success: false, error: `File is too large (${Math.round(fileStats.size / 1024 / 1024)}MB). Max: 50MB.` };
  }

  const filename = basename(filePath);
  const ext = extname(filePath).toLowerCase();
  const allowedTypes = ['.txt', '.md', '.csv', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg', '.webp', '.json', '.html', '.xml'];

  if (!allowedTypes.includes(ext)) {
    return { success: false, error: `File type ${ext} is not supported. Allowed: ${allowedTypes.join(', ')}` };
  }

  // Read file
  const buffer = await readFile(filePath);
  const title = (input.title as string) || filename.replace(/\.[^/.]+$/, '');
  const agentId = (input.agent_id as string) || null;

  // Generate a document ID
  const docId = createHash('sha256').update(`${Date.now()}-${filePath}`).digest('hex').slice(0, 32);
  const storagePath = `local://${filePath}`;

  // Create document record
  const { error: insertError } = await ctx.db
    .from('agent_workforce_knowledge_documents')
    .insert({
      id: docId,
      workspace_id: ctx.workspaceId,
      agent_id: agentId,
      title,
      filename,
      file_type: ext,
      file_size: fileStats.size,
      storage_path: storagePath,
      source_type: 'upload',
      processing_status: 'processing',
    });

  if (insertError) return { success: false, error: insertError.message };

  // Large files: enqueue for background processing instead of blocking
  if (fileStats.size > ENQUEUE_THRESHOLD_BYTES) {
    const position = await enqueueDocument(ctx.db, ctx.workspaceId, docId, {
      source_type: 'upload',
      file_path: filePath,
    });
    return {
      success: true,
      data: {
        message: `"${title}" queued for background processing (position ${position}).`,
        documentId: docId,
        queued: true,
      },
    };
  }

  // Process the file (extract + chunk)
  try {
    const text = await extractTextLocal(buffer, ext, filename);
    if (!text || text.trim().length === 0) {
      await ctx.db
        .from('agent_workforce_knowledge_documents')
        .update({ processing_status: 'failed', processing_error: 'No text could be extracted.' })
        .eq('id', docId);
      return { success: false, error: 'No text could be extracted from this file.' };
    }

    const chunks = chunkTextLocal(text);
    const contentHash = createHash('sha256').update(text).digest('hex').slice(0, 16);

    // Save chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkId = createHash('sha256').update(`${docId}-${i}`).digest('hex').slice(0, 32);
      await ctx.db
        .from('agent_workforce_knowledge_chunks')
        .insert({
          id: chunkId,
          document_id: docId,
          workspace_id: ctx.workspaceId,
          chunk_index: i,
          content: chunk.content,
          token_count: chunk.tokenCount,
          keywords: JSON.stringify(chunk.keywords),
        });
    }

    // Update corpus stats for IDF
    await updateCorpusStats(ctx.db, ctx.workspaceId, chunks, 1);

    // Generate embeddings if Ollama is available
    const embeddingModel = await embedChunks(ctx, docId, chunks);

    // Update document
    await ctx.db
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
      .eq('id', docId);

    // Cloud mirror: after the doc is fully processed, push it upstream so
    // cloud agents can see it. Send metadata only (not chunks or embeddings)
    // since cloud handles its own chunking/embedding pipeline.
    void syncKnowledgeUpstream(ctx, 'upsert', {
      id: docId,
      title,
      filename,
      file_type: ext,
      file_size: fileStats.size,
      storage_path: storagePath,
      source_type: 'upload',
      processing_status: 'ready',
      chunk_count: chunks.length,
      compiled_token_count: Math.ceil(text.length / 4),
      content_hash: contentHash,
      compiled_text: text,
      agent_id: agentId,
      is_active: 1,
    });

    return {
      success: true,
      data: {
        message: `Added "${title}" to the knowledge base (${chunks.length} chunks, ~${Math.ceil(text.length / 4)} tokens).`,
        documentId: docId,
      },
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Processing failed';
    await ctx.db
      .from('agent_workforce_knowledge_documents')
      .update({ processing_status: 'failed', processing_error: errorMsg })
      .eq('id', docId);
    return { success: false, error: errorMsg };
  }
}

// ============================================================================
// ADD KNOWLEDGE FROM URL
// ============================================================================

export async function addKnowledgeFromUrl(
  ctx: LocalToolContext,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const url = input.url as string;
  if (!url) return { success: false, error: 'url is required' };

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { success: false, error: 'Invalid URL' };
  }

  // Scrape URL
  if (!ctx.scraplingService) {
    return { success: false, error: 'Web scraping service is not available.' };
  }

  const scrapeResult = await ctx.scraplingService.fetch(url);
  if (!scrapeResult.html || scrapeResult.error) {
    return { success: false, error: scrapeResult.error || "Couldn't fetch that URL." };
  }

  // Extract text from HTML (strip tags, decode entities)
  const text = scrapeResult.html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text || text.length < 50) {
    return { success: false, error: "Couldn't extract any text from that URL." };
  }

  const title = (input.title as string) || scrapeResult.title || parsedUrl.hostname;
  const agentId = (input.agent_id as string) || null;
  const filename = `${parsedUrl.hostname}.txt`;

  const docId = createHash('sha256').update(`${Date.now()}-${url}`).digest('hex').slice(0, 32);

  const { error: insertError } = await ctx.db
    .from('agent_workforce_knowledge_documents')
    .insert({
      id: docId,
      workspace_id: ctx.workspaceId,
      agent_id: agentId,
      title,
      description: `Scraped from ${url}`,
      filename,
      file_type: '.txt',
      file_size: Buffer.byteLength(text, 'utf-8'),
      storage_path: `url://${url}`,
      source_type: 'url',
      source_url: url,
      processing_status: 'processing',
    });

  if (insertError) return { success: false, error: insertError.message };

  // Large content: enqueue for background processing
  if (Buffer.byteLength(text, 'utf-8') > ENQUEUE_THRESHOLD_BYTES) {
    // Store compiled_text so worker can use it directly
    await ctx.db
      .from('agent_workforce_knowledge_documents')
      .update({ compiled_text: text })
      .eq('id', docId);

    const position = await enqueueDocument(ctx.db, ctx.workspaceId, docId, {
      source_type: 'url',
      url,
    });
    return {
      success: true,
      data: {
        message: `"${title}" from ${parsedUrl.hostname} queued for background processing (position ${position}).`,
        documentId: docId,
        queued: true,
      },
    };
  }

  // Process
  const chunks = chunkTextLocal(text);
  const contentHash = createHash('sha256').update(text).digest('hex').slice(0, 16);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkId = createHash('sha256').update(`${docId}-${i}`).digest('hex').slice(0, 32);
    await ctx.db
      .from('agent_workforce_knowledge_chunks')
      .insert({
        id: chunkId,
        document_id: docId,
        workspace_id: ctx.workspaceId,
        chunk_index: i,
        content: chunk.content,
        token_count: chunk.tokenCount,
        keywords: JSON.stringify(chunk.keywords),
      });
  }

  // Update corpus stats for IDF
  await updateCorpusStats(ctx.db, ctx.workspaceId, chunks, 1);

  // Generate embeddings if Ollama is available
  const urlEmbeddingModel = await embedChunks(ctx, docId, chunks);

  await ctx.db
    .from('agent_workforce_knowledge_documents')
    .update({
      processing_status: 'ready',
      processed_at: new Date().toISOString(),
      compiled_text: text,
      compiled_token_count: Math.ceil(text.length / 4),
      chunk_count: chunks.length,
      content_hash: contentHash,
      ...(urlEmbeddingModel ? { embedding_model: urlEmbeddingModel } : {}),
    })
    .eq('id', docId);

  return {
    success: true,
    data: {
      message: `Added "${title}" from ${parsedUrl.hostname} (${chunks.length} chunks, ~${Math.ceil(text.length / 4)} tokens).`,
      documentId: docId,
    },
  };
}

// ============================================================================
// ASSIGN KNOWLEDGE
// ============================================================================

export async function assignKnowledge(
  ctx: LocalToolContext,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const documentId = input.document_id as string;
  const agentId = input.agent_id as string;
  if (!documentId || !agentId) {
    return { success: false, error: 'document_id and agent_id are required' };
  }

  // Verify document exists
  const { data: doc } = await ctx.db
    .from('agent_workforce_knowledge_documents')
    .select('id, title')
    .eq('id', documentId)
    .eq('workspace_id', ctx.workspaceId)
    .single();

  if (!doc) return { success: false, error: 'Document not found' };

  // Check if config already exists
  const { data: existing } = await ctx.db
    .from('agent_workforce_knowledge_agent_config')
    .select('id')
    .eq('document_id', documentId)
    .eq('agent_id', agentId)
    .single();

  const configId = existing
    ? (existing as Record<string, unknown>).id as string
    : createHash('sha256').update(`${documentId}-${agentId}`).digest('hex').slice(0, 32);

  const updates: Record<string, unknown> = {};
  if (input.opted_out !== undefined) updates.opted_out = input.opted_out ? 1 : 0;
  if (input.injection_mode !== undefined) updates.injection_mode = input.injection_mode;

  if (existing) {
    await ctx.db
      .from('agent_workforce_knowledge_agent_config')
      .update(updates)
      .eq('document_id', documentId)
      .eq('agent_id', agentId);
  } else {
    await ctx.db
      .from('agent_workforce_knowledge_agent_config')
      .insert({
        id: configId,
        document_id: documentId,
        agent_id: agentId,
        workspace_id: ctx.workspaceId,
        opted_out: input.opted_out ? 1 : 0,
        injection_mode: (input.injection_mode as string) || 'auto',
        priority: 0,
      });
  }

  return {
    success: true,
    data: {
      message: `Updated knowledge config for "${(doc as Record<string, unknown>).title}" on agent ${agentId}.`,
    },
  };
}

// ============================================================================
// DELETE KNOWLEDGE
// ============================================================================

export async function deleteKnowledge(
  ctx: LocalToolContext,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const documentId = input.document_id as string;
  if (!documentId) return { success: false, error: 'document_id is required' };

  const { data: doc } = await ctx.db
    .from('agent_workforce_knowledge_documents')
    .select('id, title')
    .eq('id', documentId)
    .eq('workspace_id', ctx.workspaceId)
    .single();

  if (!doc) return { success: false, error: 'Document not found' };

  // Fetch chunks before deletion for corpus stats decrement
  const { data: chunkRows } = await ctx.db
    .from<{ content: string }>('agent_workforce_knowledge_chunks')
    .select('content')
    .eq('document_id', documentId);

  if (chunkRows && chunkRows.length > 0) {
    const fakeChunks: LocalChunk[] = chunkRows.map((c) => ({
      content: c.content,
      tokenCount: 0,
      keywords: [],
    }));
    await updateCorpusStats(ctx.db, ctx.workspaceId, fakeChunks, -1);
  }

  // Delete chunks first (SQLite may not cascade)
  await ctx.db
    .from('agent_workforce_knowledge_chunks')
    .delete()
    .eq('document_id', documentId);

  // Delete agent configs
  await ctx.db
    .from('agent_workforce_knowledge_agent_config')
    .delete()
    .eq('document_id', documentId);

  // Delete document
  await ctx.db
    .from('agent_workforce_knowledge_documents')
    .delete()
    .eq('id', documentId);

  void syncKnowledgeUpstream(ctx, 'delete', { id: documentId });

  return {
    success: true,
    data: { message: `Deleted "${(doc as Record<string, unknown>).title}" from the knowledge base.` },
  };
}

// ============================================================================
// LOCAL TEXT EXTRACTION (simplified, no heavy deps)
// ============================================================================

export async function extractTextLocal(buffer: Buffer, ext: string, _filename: string): Promise<string> {
  const type = ext.replace('.', '').toLowerCase();

  switch (type) {
    case 'txt':
    case 'md':
    case 'html':
    case 'xml':
    case 'csv':
    case 'json':
      return buffer.toString('utf-8');

    case 'pdf': {
      try {
        const pdfParse = (await import('pdf-parse')).default;
        const result = await pdfParse(buffer, { max: 200 });
        return result.text?.trim() || '';
      } catch {
        return '';
      }
    }

    default:
      // Try as plain text
      return buffer.toString('utf-8');
  }
}

// ============================================================================
// LOCAL CHUNKING (simplified inline version)
// ============================================================================

interface LocalChunk {
  content: string;
  tokenCount: number;
  keywords: string[];
}

function chunkTextLocal(text: string): LocalChunk[] {
  return chunkText(text).map((c) => ({
    content: c.content,
    tokenCount: c.tokenCount,
    keywords: c.keywords,
  }));
}

// ============================================================================
// EMBEDDING HELPER
// ============================================================================

/** Generate and store embeddings for chunks. Returns the model name if any were embedded. */
async function embedChunks(
  ctx: LocalToolContext,
  docId: string,
  chunks: LocalChunk[],
): Promise<string | undefined> {
  if (!ctx.ollamaUrl || !ctx.embeddingModel) return undefined;

  const chunkTexts = chunks.map((c) => c.content);
  const embeddings = await generateEmbeddings(chunkTexts, ctx.ollamaUrl, ctx.embeddingModel);
  let embeddedCount = 0;
  for (let i = 0; i < chunks.length; i++) {
    const emb = embeddings[i];
    if (emb) {
      const chunkId = createHash('sha256').update(`${docId}-${i}`).digest('hex').slice(0, 32);
      await ctx.db
        .from('agent_workforce_knowledge_chunks')
        .update({ embedding: serializeEmbedding(emb) })
        .eq('id', chunkId);
      embeddedCount++;
    }
  }
  return embeddedCount > 0 ? ctx.embeddingModel : undefined;
}

// ============================================================================
// CORPUS STATS (IDF tracking)
// ============================================================================

/** Collect unique terms across all chunks and update rag_corpus_stats doc_frequency. */
export async function updateCorpusStats(
  db: import('../../db/adapter-types.js').DatabaseAdapter,
  workspaceId: string,
  chunks: LocalChunk[],
  delta: 1 | -1,
): Promise<void> {
  try {
    // Collect unique terms across all chunks in this document
    const docTerms = new Set<string>();
    for (const chunk of chunks) {
      for (const t of tokenize(chunk.content)) {
        docTerms.add(t);
      }
    }

    const terms = [...docTerms];
    if (terms.length === 0) return;

    // Batch fetch existing stats for all terms at once
    const { data: existingRows } = await db
      .from<{ term: string; doc_frequency: number }>('rag_corpus_stats')
      .select('term, doc_frequency')
      .eq('workspace_id', workspaceId)
      .in('term', terms);

    const existingMap = new Map<string, number>();
    for (const row of existingRows ?? []) {
      existingMap.set(row.term, row.doc_frequency);
    }

    const now = new Date().toISOString();

    // Batch operations by type to minimize round-trips
    const toInsert: string[] = [];
    const toUpdate: Array<{ term: string; newFreq: number }> = [];
    const toDelete: string[] = [];

    for (const term of terms) {
      const current = existingMap.get(term);
      if (delta > 0) {
        if (current === undefined) {
          toInsert.push(term);
        } else {
          toUpdate.push({ term, newFreq: current + 1 });
        }
      } else {
        if (current !== undefined) {
          const newFreq = current - 1;
          if (newFreq <= 0) {
            toDelete.push(term);
          } else {
            toUpdate.push({ term, newFreq });
          }
        }
      }
    }

    // Execute batched inserts (single DB round-trip via transaction)
    if (toInsert.length > 0) {
      await db.from('rag_corpus_stats').insert(
        toInsert.map(term => ({ workspace_id: workspaceId, term, doc_frequency: 1 }))
      );
    }

    // Execute batched updates (parallelized, each needs distinct values)
    if (toUpdate.length > 0) {
      await Promise.allSettled(toUpdate.map(({ term, newFreq }) =>
        db.from('rag_corpus_stats')
          .update({ doc_frequency: newFreq, updated_at: now })
          .eq('workspace_id', workspaceId)
          .eq('term', term)
      ));
    }

    // Execute batched deletes (single DB round-trip via .in())
    if (toDelete.length > 0) {
      await db.from('rag_corpus_stats').delete()
        .eq('workspace_id', workspaceId)
        .in('term', toDelete);
    }
  } catch {
    // Best-effort: don't fail document operations if stats update fails
  }
}

// ============================================================================
// SEARCH KNOWLEDGE
// ============================================================================

export async function searchKnowledge(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const query = input.query as string | undefined;
  if (!query?.trim()) {
    return { success: false, error: 'A query is required.' };
  }

  const maxResults = Math.min(Number(input.max_results) || 5, 10);

  // Exact-title boost: if the user's query matches a document title
  // (case-insensitive, whitespace-normalized), surface a hint pointing at
  // get_knowledge_document AND bias the chunk retrieval so that doc's
  // chunks rank higher. Without this, BM25 similarity can return chunks
  // from a completely different doc because they happen to share tokens
  // with the query, even when the user literally asked for a known
  // document by title.
  const normalizedQuery = query.trim().toLowerCase();
  let exactTitleMatch: { id: string; title: string } | null = null;
  try {
    const { data: titleRows } = await ctx.db
      .from<{ id: string; title: string }>('agent_workforce_knowledge_documents')
      .select('id, title')
      .eq('workspace_id', ctx.workspaceId)
      .eq('is_active', 1);
    if (titleRows) {
      const match = (titleRows as Array<{ id: string; title: string }>).find(
        (r) => r.title.trim().toLowerCase() === normalizedQuery,
      );
      if (match) exactTitleMatch = match;
    }
  } catch { /* non-fatal, continue with plain search */ }

  const chunks = await retrieveKnowledgeChunks({
    db: ctx.db,
    workspaceId: ctx.workspaceId,
    agentId: '__orchestrator__',
    query,
    tokenBudget: 6000,
    maxChunks: maxResults,
    ollamaUrl: ctx.ollamaUrl,
    embeddingModel: ctx.embeddingModel,
    bm25Weight: ctx.ragBm25Weight,
    expandQueries: !!ctx.ollamaUrl,
    ollamaModel: ctx.ollamaModel,
    rerankerEnabled: ctx.rerankerEnabled,
    meshRagEnabled: ctx.meshRagEnabled,
  });

  // Re-rank: if we have an exact title match, promote chunks from that
  // doc to the top of the result list. Preserves ordering within each
  // group. Cheap and deterministic.
  let rerankedChunks = chunks;
  if (exactTitleMatch) {
    const matchTitle = exactTitleMatch.title;
    rerankedChunks = [
      ...chunks.filter((c) => c.documentTitle === matchTitle),
      ...chunks.filter((c) => c.documentTitle !== matchTitle),
    ];
  }

  if (rerankedChunks.length === 0 && !exactTitleMatch) {
    return {
      success: true,
      data: { message: 'Nothing in the knowledge base matched that query.', results: [] },
    };
  }

  const titleHint = exactTitleMatch
    ? `Your query exactly matches the title of document "${exactTitleMatch.title}" (id: ${exactTitleMatch.id}). For the full document text, call get_knowledge_document with document_id="${exactTitleMatch.id}" — the chunks below are similarity fragments and may not include the whole procedure.`
    : undefined;

  return {
    success: true,
    data: {
      query,
      resultCount: rerankedChunks.length,
      exactTitleMatch: exactTitleMatch
        ? { id: exactTitleMatch.id, title: exactTitleMatch.title }
        : undefined,
      hint: titleHint,
      results: rerankedChunks.map((c) => ({
        documentTitle: c.documentTitle,
        content: c.content,
        score: Math.round(c.score * 100) / 100,
        tokens: c.tokenCount,
      })),
    },
  };
}
