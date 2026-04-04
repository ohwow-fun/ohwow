/**
 * RAG Retrieval — BM25-based knowledge and memory retrieval.
 * No embedding model required, works offline.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../logger.js';
import { generateEmbedding, cosineSimilarity, deserializeEmbedding } from './embeddings.js';
import { getRelatedChunkIds } from './knowledge-graph.js';
import { rerankWithLLM } from './reranker.js';

// ============================================================================
// TYPES
// ============================================================================

export interface RagChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  content: string;
  score: number;
  tokenCount: number;
}

export interface RagMemory {
  id: string;
  memoryType: string;
  content: string;
  score: number;
  createdAt?: string;
  trustLevel?: string;
}

export interface RetrieveKnowledgeOptions {
  db: DatabaseAdapter;
  workspaceId: string;
  agentId: string; // '__orchestrator__' for orchestrator
  query: string;
  tokenBudget?: number; // default 6000
  maxChunks?: number;   // default 8
  minScore?: number;    // default 0.01
  /** Ollama URL for embedding-based hybrid search */
  ollamaUrl?: string;
  /** Embedding model name (default: nomic-embed-text) */
  embeddingModel?: string;
  /** BM25 weight in hybrid score: 0.0 = pure embedding, 1.0 = pure BM25 (default: 0.5) */
  bm25Weight?: number;
  /** Enable query expansion via local LLM */
  expandQueries?: boolean;
  /** Ollama model for query expansion (default: qwen3:4b) */
  ollamaModel?: string;
  /** Enable LLM-based reranking of top candidates */
  rerankerEnabled?: boolean;
  /** Enable mesh-distributed retrieval across peers */
  meshRagEnabled?: boolean;
}

export interface RetrieveMemoriesOptions {
  db: DatabaseAdapter;
  workspaceId: string;
  query: string;
  limit?: number;    // default 10
  minScore?: number; // default 0.01
  agentId?: string;  // if set → agent_workforce_agent_memory; unset → orchestrator_memory
}

// ============================================================================
// BM25 ENGINE
// ============================================================================

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'it', 'its', 'this', 'that', 'not', 'you', 'they',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/**
 * BM25 scoring with optional IDF from corpus statistics.
 * When idfMap/corpusSize are provided, uses proper IDF weighting.
 * Without them, falls back to IDF=1 (original behavior).
 */
export function bm25Score(
  queryTokens: string[],
  docText: string,
  idfMap?: Map<string, number>,
  corpusSize?: number,
): number {
  if (queryTokens.length === 0) return 0;

  const k1 = 1.5;
  const b = 0.75;
  const avgDocLen = 800; // chars, estimated

  const docTokens = tokenize(docText);
  const docLen = docText.length;

  // Build term frequency map
  const tf = new Map<string, number>();
  for (const t of docTokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }

  const useIdf = idfMap && corpusSize && corpusSize > 0;

  let score = 0;
  for (const qt of queryTokens) {
    const freq = tf.get(qt) ?? 0;
    if (freq === 0) continue;

    // IDF: use corpus stats when available, otherwise treat as 1
    const idf = useIdf
      ? Math.log(((corpusSize as number) - (idfMap.get(qt) ?? 0) + 0.5) / ((idfMap.get(qt) ?? 0) + 0.5) + 1)
      : 1;

    const numerator = freq * (k1 + 1);
    const denominator = freq + k1 * (1 - b + b * (docLen / avgDocLen));
    score += idf * (numerator / denominator);
  }

  return score;
}

// ============================================================================
// QUERY EXPANSION
// ============================================================================

/**
 * Expand a query into multiple phrasings using the local LLM.
 * Returns the union of tokens from all phrasings.
 * Falls back to original query tokens if LLM is unavailable.
 */
export async function expandQuery(
  query: string,
  originalTokens: string[],
  ollamaUrl: string,
  model: string,
): Promise<string[]> {
  try {
    const response = await fetch(`${ollamaUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000), // fast timeout — don't block retrieval
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: `Generate 3 alternative search queries for: "${query}". Return ONLY a JSON array of strings, no explanation. Example: ["query1","query2","query3"]`,
          },
        ],
        max_tokens: 200,
        temperature: 0.7,
        stream: false,
      }),
    });
    if (!response.ok) return originalTokens;

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';

    // Parse JSON array from response (tolerant of markdown fences and thinking tags)
    const cleaned = content
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/```json?\n?/g, '')
      .replace(/```/g, '')
      .trim();
    const alternatives: string[] = JSON.parse(cleaned);

    if (!Array.isArray(alternatives)) return originalTokens;

    // Union all tokens
    const allTokens = new Set(originalTokens);
    for (const alt of alternatives) {
      if (typeof alt === 'string') {
        for (const t of tokenize(alt)) allTokens.add(t);
      }
    }
    return [...allTokens];
  } catch {
    return originalTokens; // graceful fallback
  }
}

// ============================================================================
// KNOWLEDGE RETRIEVAL
// ============================================================================

export async function retrieveKnowledgeChunks(opts: RetrieveKnowledgeOptions): Promise<RagChunk[]> {
  const {
    db,
    workspaceId,
    agentId,
    query,
    tokenBudget = 6000,
    maxChunks = 8,
    minScore = 0.01,
  } = opts;

  try {
    // 1. Fetch eligible docs (ready, active, workspace or this agent)
    const { data: docData } = await db
      .from<{ id: string; title: string; processing_status: string; is_active: number; agent_id: string | null }>('agent_workforce_knowledge_documents')
      .select('id, title, processing_status, is_active, agent_id')
      .eq('workspace_id', workspaceId)
      .eq('processing_status', 'ready')
      .eq('is_active', 1)
      .or(`agent_id.is.null,agent_id.eq.${agentId}`);

    if (!docData || docData.length === 0) return [];

    // 2. Fetch agent config (opt-outs + injection_mode)
    const { data: configData } = await db
      .from<{ document_id: string; opted_out: number; injection_mode: string }>('agent_workforce_knowledge_agent_config')
      .select('document_id, opted_out, injection_mode')
      .eq('agent_id', agentId)
      .eq('workspace_id', workspaceId);

    const configs = configData ?? [];
    const configByDoc = new Map(configs.map((c) => [c.document_id, c]));

    // 3. Filter eligible docs
    const eligibleDocs = (docData ?? []).filter((doc) => {
      const config = configByDoc.get(doc.id);
      // Skip opted-out workspace-wide docs
      if (!doc.agent_id && config?.opted_out) return false;
      // Skip on_demand docs (retrieved only when explicitly requested)
      if (config?.injection_mode === 'on_demand') return false;
      return true;
    });

    if (eligibleDocs.length === 0) return [];

    const docIds = eligibleDocs.map((d) => d.id);
    const docTitleMap = new Map(eligibleDocs.map((d) => [d.id, d.title]));

    // 4. Fetch all chunks for eligible docs (include embedding if available)
    const { data: chunkData } = await db
      .from<{ id: string; document_id: string; content: string; keywords: string | string[] | null; token_count: number; embedding: Buffer | null }>('agent_workforce_knowledge_chunks')
      .select('id, document_id, content, keywords, token_count, embedding')
      .in('document_id', docIds);

    if (!chunkData || chunkData.length === 0) return [];

    const chunks = chunkData ?? [];

    // 5. Load corpus stats for IDF weighting
    let idfMap: Map<string, number> | undefined;
    let corpusSize: number | undefined;
    try {
      const { data: statsData } = await db
        .from<{ term: string; doc_frequency: number }>('rag_corpus_stats')
        .select('term, doc_frequency')
        .eq('workspace_id', workspaceId);

      if (statsData && statsData.length > 0) {
        idfMap = new Map<string, number>();
        for (const row of statsData) {
          idfMap.set(row.term, row.doc_frequency);
        }
        // Use total workspace doc count for IDF, not just eligible docs
        const countResult = await db
          .from('agent_workforce_knowledge_documents')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId);
        corpusSize = countResult.count ?? eligibleDocs.length;
      }
    } catch {
      // Table may not exist yet (pre-migration) — fall back to no IDF
    }

    // 6. Query expansion (optional)
    const baseTokens = tokenize(query);
    const queryTokens = (opts.expandQueries && opts.ollamaUrl && opts.ollamaModel)
      ? await expandQuery(query, baseTokens, opts.ollamaUrl, opts.ollamaModel)
      : baseTokens;

    const scored: RagChunk[] = chunks.map((chunk) => {
      const config = configByDoc.get(chunk.document_id);
      const isAlways = config?.injection_mode === 'always';

      let score: number;
      if (isAlways) {
        score = Infinity;
      } else {
        // Parse keywords from JSON or array
        let keywords: string[] = [];
        if (chunk.keywords) {
          if (typeof chunk.keywords === 'string') {
            try { keywords = JSON.parse(chunk.keywords); } catch { keywords = []; }
          } else {
            keywords = chunk.keywords;
          }
        }
        // Weight keywords twice as heavily by repeating them in the scored text
        const scoredText = `${keywords.join(' ')} ${keywords.join(' ')} ${chunk.content}`;
        score = bm25Score(queryTokens, scoredText, idfMap, corpusSize);
      }

      return {
        id: chunk.id,
        documentId: chunk.document_id,
        documentTitle: docTitleMap.get(chunk.document_id) ?? 'Unknown',
        content: chunk.content,
        score,
        tokenCount: chunk.token_count || Math.ceil(chunk.content.length / 4),
      };
    });

    // 7. Hybrid scoring: combine BM25 with embedding cosine similarity
    const bm25Weight = opts.bm25Weight ?? 0.5;
    if (opts.ollamaUrl && opts.embeddingModel) {
      try {
        const queryEmbedding = await generateEmbedding(query, opts.ollamaUrl, opts.embeddingModel);
        if (queryEmbedding) {
          // Normalize BM25 scores to 0-1 range
          const finiteBm25Scores = scored.filter((c) => c.score !== Infinity).map((c) => c.score);
          const maxBm25 = finiteBm25Scores.length > 0 ? Math.max(...finiteBm25Scores) : 1;

          for (let i = 0; i < scored.length; i++) {
            if (scored[i].score === Infinity) continue; // always-inject docs keep Infinity

            const chunk = chunks[i];
            if (chunk.embedding) {
              const chunkEmbedding = deserializeEmbedding(chunk.embedding as Buffer);
              const cosine = Math.max(0, cosineSimilarity(queryEmbedding.embedding, chunkEmbedding));
              const normalizedBm25 = maxBm25 > 0 ? scored[i].score / maxBm25 : 0;
              scored[i].score = bm25Weight * normalizedBm25 + (1 - bm25Weight) * cosine;
            }
            // Chunks without embeddings keep their BM25 score as-is
          }
        }
      } catch {
        // Embedding failed — continue with BM25 scores only
      }
    }

    // 8. Optional: LLM-based reranking
    if (opts.rerankerEnabled && opts.ollamaUrl && opts.ollamaModel) {
      const candidates = scored
        .filter(c => c.score !== Infinity && c.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map((c, i) => ({ index: scored.indexOf(c), content: c.content, originalScore: c.score }));

      if (candidates.length > 0) {
        const reranked = await rerankWithLLM(query, candidates, opts.ollamaUrl, opts.ollamaModel);
        for (const r of reranked) {
          scored[r.index].score = r.score;
        }
      }
    }

    // 8b. Boost chunks related via knowledge graph
    if (opts.ollamaUrl) {
      try {
        const topChunkIds = scored
          .filter(c => c.score !== Infinity)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map(c => c.id);

        const relatedIds = await getRelatedChunkIds(db, workspaceId, topChunkIds, 1);
        const relatedSet = new Set(relatedIds);

        for (const s of scored) {
          if (relatedSet.has(s.id) && s.score !== Infinity) {
            s.score += 0.1; // small boost for graph-connected chunks
          }
        }
      } catch {
        // Graph not available yet — skip
      }
    }

    // 8c. Optional: merge results from mesh peers
    if (opts.meshRagEnabled && opts.db) {
      try {
        const { retrieveFromMesh } = await import('./distributed-retrieval.js');
        const meshResult = await retrieveFromMesh({
          db: opts.db,
          workspaceId,
          query,
          maxPeers: 3,
          timeout: 10_000,
          tokenBudget: Math.floor(tokenBudget / 3),
          maxChunks: Math.floor(maxChunks / 2),
        });

        for (const chunk of meshResult.chunks) {
          const isDupe = scored.some(s =>
            s.content.slice(0, 100) === chunk.content.slice(0, 100)
          );
          if (!isDupe) {
            scored.push(chunk);
          }
        }
      } catch {
        // Mesh unavailable — continue with local results only
      }
    }

    // 9. Filter by minScore (except 'always' docs), sort desc, apply budget
    const filtered = scored.filter((c) => c.score === Infinity || c.score >= minScore);
    filtered.sort((a, b) => b.score - a.score);

    const results: RagChunk[] = [];
    let totalTokens = 0;

    for (const chunk of filtered) {
      if (results.length >= maxChunks) break;

      const tokens = chunk.tokenCount;
      if (totalTokens + tokens > tokenBudget && results.length > 0) {
        // Over budget — skip unless it's the first result (always include at least 1)
        continue;
      }

      results.push(chunk);
      totalTokens += tokens;
    }

    return results;
  } catch (err) {
    logger.error({ err }, '[RAG] retrieveKnowledgeChunks failed');
    return [];
  }
}

// ============================================================================
// MEMORY RETRIEVAL
// ============================================================================

export async function retrieveRelevantMemories(opts: RetrieveMemoriesOptions): Promise<RagMemory[]> {
  const {
    db,
    workspaceId,
    query,
    limit = 10,
    minScore = 0.01,
    agentId,
  } = opts;

  try {
    const table = agentId ? 'agent_workforce_agent_memory' : 'orchestrator_memory';
    const hasUsageTracking = !!agentId; // Only agent_memory table has times_used/last_used_at
    const selectCols = hasUsageTracking
      ? 'id, memory_type, content, created_at, times_used, trust_level'
      : 'id, memory_type, content, created_at';
    let queryBuilder = db
      .from<{ id: string; memory_type: string; content: string; created_at: string; times_used?: number; trust_level?: string }>(table)
      .select(selectCols)
      .eq('workspace_id', workspaceId)
      .eq('is_active', 1);

    if (agentId) {
      queryBuilder = queryBuilder.eq('agent_id', agentId);
    }

    const { data } = await queryBuilder.order('created_at', { ascending: false });

    if (!data || data.length === 0) return [];

    const memories = data ?? [];

    const queryTokens = tokenize(query);
    const now = Date.now();

    // Trust level priority: verified > inferred > cross_agent
    const TRUST_PRIORITY: Record<string, number> = { verified: 0, inferred: 1, cross_agent: 2 };

    const scored: RagMemory[] = memories.map((m) => {
      const relevanceScore = bm25Score(queryTokens, m.content);

      // Recency boost: decays linearly over 90 days
      const ageInDays = (now - new Date(m.created_at).getTime()) / 86400000;
      const recencyBoost = Math.max(0, 1 - ageInDays / 90);

      // Trust boost: verified memories get a small bonus
      const trustBoost = m.trust_level === 'verified' ? 0.1 : 0;

      // Composite score: 65% relevance, 25% recency, 10% trust
      const compositeScore = relevanceScore > 0
        ? relevanceScore * 0.65 + recencyBoost * 0.25 + trustBoost
        : 0; // Don't boost irrelevant memories with recency/trust alone

      return {
        id: m.id,
        memoryType: m.memory_type,
        content: m.content,
        score: compositeScore,
        createdAt: m.created_at,
        trustLevel: m.trust_level,
      };
    });

    // If all scores are below minScore (e.g. greeting), fall back to recency (already ordered)
    const hasRelevant = scored.some((m) => m.score >= minScore);

    if (!hasRelevant) {
      // Recency fallback: return top `limit` as-is (already desc by created_at)
      return scored.slice(0, limit);
    }

    // Sort by composite score desc, then trust level as tiebreaker
    scored.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > 0.01) return scoreDiff;
      // Tiebreaker: verified before inferred before cross_agent
      return (TRUST_PRIORITY[a.trustLevel ?? 'inferred'] ?? 1) - (TRUST_PRIORITY[b.trustLevel ?? 'inferred'] ?? 1);
    });
    const results = scored.slice(0, limit);

    // Update usage tracking for retrieved agent memories (fire-and-forget)
    const retrievedIds = results.filter(m => m.score >= minScore).map(m => m.id);
    if (hasUsageTracking && retrievedIds.length > 0) {
      const nowIso = new Date().toISOString();
      // Build a map of current times_used from the fetched data
      const usageMap = new Map<string, number>();
      for (const m of memories) {
        usageMap.set(m.id, m.times_used ?? 0);
      }
      for (const id of retrievedIds) {
        db.from(table)
          .update({
            times_used: (usageMap.get(id) ?? 0) + 1,
            last_used_at: nowIso,
          })
          .eq('id', id)
          .then(() => {}, () => {}); // Best-effort, don't block retrieval
      }
    }

    return results;
  } catch (err) {
    logger.error({ err }, '[RAG] retrieveRelevantMemories failed');
    return [];
  }
}

// ============================================================================
// FORMATTERS
// ============================================================================

export function formatRagChunks(chunks: RagChunk[]): string | undefined {
  if (chunks.length === 0) return undefined;

  const parts = chunks.map((c) => `**${c.documentTitle}**\n${c.content}`);
  return parts.join('\n\n');
}

export function formatRelevantMemories(memories: RagMemory[]): string | undefined {
  if (memories.length === 0) return undefined;

  const grouped: Record<string, string[]> = {};
  for (const m of memories) {
    (grouped[m.memoryType] ??= []).push(m.content);
  }

  const sections = Object.entries(grouped)
    .map(([type, items]) => `**${type}**:\n${items.map((c) => `- ${c}`).join('\n')}`)
    .join('\n\n');

  return sections;
}
