/**
 * Orchestrator Tools — Knowledge Base
 * Local runtime handlers for knowledge document management.
 */

import type { LocalToolContext } from '../local-tool-types.js';
import type { ToolResult } from '../local-tool-types.js';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { retrieveKnowledgeChunks, tokenize } from '../../lib/rag/retrieval.js';
import { generateEmbeddings, serializeEmbedding } from '../../lib/rag/embeddings.js';
import { chunkText } from '../../lib/rag/chunker.js';

// ============================================================================
// LIST KNOWLEDGE
// ============================================================================

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

  return {
    success: true,
    data: { message: `Deleted "${(doc as Record<string, unknown>).title}" from the knowledge base.` },
  };
}

// ============================================================================
// LOCAL TEXT EXTRACTION (simplified, no heavy deps)
// ============================================================================

async function extractTextLocal(buffer: Buffer, ext: string, _filename: string): Promise<string> {
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
async function updateCorpusStats(
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

    // Execute batched inserts
    for (const term of toInsert) {
      await db.from('rag_corpus_stats')
        .insert({ workspace_id: workspaceId, term, doc_frequency: 1 });
    }

    // Execute batched updates
    for (const { term, newFreq } of toUpdate) {
      await db.from('rag_corpus_stats')
        .update({ doc_frequency: newFreq, updated_at: now })
        .eq('workspace_id', workspaceId)
        .eq('term', term);
    }

    // Execute batched deletes
    for (const term of toDelete) {
      await db.from('rag_corpus_stats').delete()
        .eq('workspace_id', workspaceId)
        .eq('term', term);
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
  });

  if (chunks.length === 0) {
    return {
      success: true,
      data: { message: 'Nothing in the knowledge base matched that query.', results: [] },
    };
  }

  return {
    success: true,
    data: {
      query,
      resultCount: chunks.length,
      results: chunks.map((c) => ({
        documentTitle: c.documentTitle,
        content: c.content,
        score: Math.round(c.score * 100) / 100,
        tokens: c.tokenCount,
      })),
    },
  };
}
