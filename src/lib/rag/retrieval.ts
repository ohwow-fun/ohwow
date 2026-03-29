/**
 * RAG Retrieval — BM25-based knowledge and memory retrieval.
 * No embedding model required, works offline.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../logger.js';

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
 * Simplified BM25 scoring. No corpus stats needed at this scale.
 * avgDocLen is estimated inline based on typical chunk sizes (~200 tokens ≈ 800 chars).
 */
export function bm25Score(queryTokens: string[], docText: string): number {
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

  let score = 0;
  for (const qt of queryTokens) {
    const freq = tf.get(qt) ?? 0;
    if (freq === 0) continue;
    // BM25 term score (no IDF needed at this scale — treat as 1)
    const numerator = freq * (k1 + 1);
    const denominator = freq + k1 * (1 - b + b * (docLen / avgDocLen));
    score += numerator / denominator;
  }

  return score;
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

    // 4. Fetch all chunks for eligible docs
    const { data: chunkData } = await db
      .from<{ id: string; document_id: string; content: string; keywords: string | string[] | null; token_count: number }>('agent_workforce_knowledge_chunks')
      .select('id, document_id, content, keywords, token_count')
      .in('document_id', docIds);

    if (!chunkData || chunkData.length === 0) return [];

    const chunks = chunkData ?? [];

    // 5. Score chunks
    const queryTokens = tokenize(query);

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
        score = bm25Score(queryTokens, scoredText);
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

    // 6. Filter by minScore (except 'always' docs), sort desc, apply budget
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
