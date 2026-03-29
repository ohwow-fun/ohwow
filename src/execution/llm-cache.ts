/**
 * Local LLM Response Cache
 * Caches LLM responses using BM25 similarity for offline-compatible
 * semantic matching. Falls back to exact hash matching.
 *
 * Works entirely within SQLite, no external dependencies required.
 */

import crypto from 'crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { tokenize, bm25Score } from '../lib/rag/retrieval.js';
import { logger } from '../lib/logger.js';

export interface LocalCacheEntry {
  id: string;
  responseContent: string;
  responseTokens: { input_tokens: number; output_tokens: number };
  qualityScore: number;
  similarity: number;
}

export interface LocalCacheConfig {
  /** BM25 similarity threshold (0+, higher = stricter). Default 3.0 */
  similarityThreshold?: number;
  /** Max entries before LRU eviction kicks in. Default 500 */
  maxEntries?: number;
  /** Whether caching is enabled. Default true */
  enabled?: boolean;
}

const DEFAULT_SIMILARITY_THRESHOLD = 3.0;
const DEFAULT_MAX_ENTRIES = 500;
const TABLE = 'llm_response_cache';

interface CacheRow {
  id: string;
  request_text: string;
  response_content: string;
  response_tokens: string;
  quality_score: number;
  usage_count: number;
}

function hashString(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Extract the last user message text for cache keying.
 */
function extractCacheKey(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((block: { type: string }) => block.type === 'text')
          .map((block: { text: string }) => block.text);
        if (textParts.length > 0) return textParts.join('\n');
      }
    }
  }
  return '';
}

export class LocalLLMCache {
  private config: Required<LocalCacheConfig>;

  constructor(
    private db: DatabaseAdapter,
    private workspaceId: string,
    config: LocalCacheConfig = {},
  ) {
    this.config = {
      similarityThreshold: config.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD,
      maxEntries: config.maxEntries ?? DEFAULT_MAX_ENTRIES,
      enabled: config.enabled ?? true,
    };
  }

  /**
   * Look up a cached response for the given messages.
   */
  async lookup(
    systemPromptHash: string,
    messages: Array<{ role: string; content: unknown }>,
    model: string,
  ): Promise<LocalCacheEntry | null> {
    if (!this.config.enabled) return null;

    const cacheKey = extractCacheKey(messages);
    if (!cacheKey) return null;

    const requestHash = hashString(`${systemPromptHash}:${model}:${cacheKey}`);

    try {
      // Fast path: exact hash match
      const { data: exactMatches } = await this.db
        .from(TABLE)
        .select('id, response_content, response_tokens, quality_score, usage_count')
        .eq('workspace_id', this.workspaceId)
        .eq('request_hash', requestHash)
        .eq('model', model)
        .limit(1);

      if (exactMatches && exactMatches.length > 0) {
        const match = exactMatches[0] as unknown as CacheRow;
        // Update usage stats
        void this.db
          .from(TABLE)
          .update({
            usage_count: (match.usage_count ?? 0) + 1,
            last_used_at: new Date().toISOString(),
          })
          .eq('id', match.id)
          .then(() => {});

        const tokens = typeof match.response_tokens === 'string'
          ? JSON.parse(match.response_tokens) as { input_tokens: number; output_tokens: number }
          : { input_tokens: 0, output_tokens: 0 };

        return {
          id: String(match.id),
          responseContent: String(match.response_content),
          responseTokens: tokens,
          qualityScore: Number(match.quality_score ?? 1.0),
          similarity: 1.0,
        };
      }

      // Semantic path: BM25 similarity search
      const queryTokens = tokenize(cacheKey);
      if (queryTokens.length === 0) return null;

      // Load recent cache entries for this model + system prompt
      const { data: candidates } = await this.db
        .from(TABLE)
        .select('id, request_text, response_content, response_tokens, quality_score, usage_count')
        .eq('workspace_id', this.workspaceId)
        .eq('model', model)
        .eq('system_prompt_hash', systemPromptHash)
        .order('last_used_at', { ascending: false })
        .limit(100);

      if (!candidates || candidates.length === 0) return null;

      let bestMatch: CacheRow | null = null;
      let bestScore = 0;

      for (const raw of candidates) {
        const candidate = raw as unknown as CacheRow;
        const score = bm25Score(queryTokens, String(candidate.request_text));
        if (score > bestScore && score >= this.config.similarityThreshold) {
          bestScore = score;
          bestMatch = candidate;
        }
      }

      if (bestMatch) {
        // Update usage stats
        void this.db
          .from(TABLE)
          .update({
            usage_count: (bestMatch.usage_count ?? 0) + 1,
            last_used_at: new Date().toISOString(),
          })
          .eq('id', bestMatch.id)
          .then(() => {});

        const tokens = typeof bestMatch.response_tokens === 'string'
          ? JSON.parse(bestMatch.response_tokens) as { input_tokens: number; output_tokens: number }
          : { input_tokens: 0, output_tokens: 0 };

        return {
          id: String(bestMatch.id),
          responseContent: String(bestMatch.response_content),
          responseTokens: tokens,
          qualityScore: Number(bestMatch.quality_score ?? 1.0),
          similarity: bestScore,
        };
      }

      return null;
    } catch (err) {
      logger.warn({ err }, 'Local LLM cache lookup failed');
      return null;
    }
  }

  /**
   * Store a response in the cache.
   */
  async store(
    systemPromptHash: string,
    messages: Array<{ role: string; content: unknown }>,
    model: string,
    responseContent: string,
    responseTokens: { input_tokens: number; output_tokens: number },
  ): Promise<void> {
    if (!this.config.enabled || !responseContent) return;

    const cacheKey = extractCacheKey(messages);
    if (!cacheKey) return;

    const requestHash = hashString(`${systemPromptHash}:${model}:${cacheKey}`);

    try {
      // Check if this hash already exists (upsert)
      const { data: existing } = await this.db
        .from(TABLE)
        .select('id')
        .eq('workspace_id', this.workspaceId)
        .eq('request_hash', requestHash)
        .limit(1);

      if (existing && existing.length > 0) {
        // Update existing entry
        await this.db.from(TABLE).update({
          response_content: responseContent,
          response_tokens: JSON.stringify(responseTokens),
          last_used_at: new Date().toISOString(),
        }).eq('id', existing[0].id);
      } else {
        // Insert new entry
        await this.db.from(TABLE).insert({
          workspace_id: this.workspaceId,
          request_text: cacheKey.slice(0, 10000),
          request_hash: requestHash,
          model,
          system_prompt_hash: systemPromptHash,
          response_content: responseContent,
          response_tokens: JSON.stringify(responseTokens),
          quality_score: 1.0,
          usage_count: 1,
        });

        // Evict old entries if over max
        await this.evict();
      }
    } catch (err) {
      logger.warn({ err }, 'Local LLM cache store failed');
    }
  }

  /**
   * Evict oldest, least-used entries when cache exceeds max size.
   */
  private async evict(): Promise<void> {
    try {
      const { data: countResult } = await this.db
        .from(TABLE)
        .select('id')
        .eq('workspace_id', this.workspaceId);

      const count = countResult?.length ?? 0;
      if (count <= this.config.maxEntries) return;

      const toRemove = count - this.config.maxEntries;
      // Remove entries with lowest usage_count, oldest last_used_at
      const { data: victims } = await this.db
        .from(TABLE)
        .select('id')
        .eq('workspace_id', this.workspaceId)
        .order('usage_count', { ascending: true })
        .order('last_used_at', { ascending: true })
        .limit(toRemove);

      if (victims) {
        for (const v of victims) {
          await this.db.from(TABLE).delete().eq('id', (v as unknown as CacheRow).id);
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Cache eviction failed');
    }
  }
}
