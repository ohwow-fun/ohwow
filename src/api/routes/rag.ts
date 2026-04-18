/**
 * RAG Query Route
 *
 * Peer-to-peer knowledge retrieval endpoint.
 * Authenticated via X-Peer-Token header (checked against workspace_peers table).
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { retrieveKnowledgeChunks } from '../../lib/rag/retrieval.js';
import { logger } from '../../lib/logger.js';

export interface RagRouterConfig {
  /** Ollama URL used for query expansion + graph extraction. Embedding
   *  generation now runs on the in-daemon Qwen3 singleton regardless of
   *  this value. */
  ollamaUrl?: string;
  /** Ollama chat model for query expansion. */
  ollamaModel?: string;
  ragBm25Weight?: number;
  rerankerEnabled?: boolean;
}

/**
 * Public RAG query route for mesh peers.
 * Must be mounted BEFORE the auth middleware (uses X-Peer-Token auth).
 */
export function createRagPublicRouter(db: DatabaseAdapter, config: RagRouterConfig): Router {
  const router = Router();

  router.post('/api/rag/query', async (req, res) => {
    // Authenticate via peer token
    const peerToken = req.headers['x-peer-token'] as string | undefined;
    if (!peerToken) {
      res.status(401).json({ error: 'X-Peer-Token header is required' });
      return;
    }

    // Verify token exists in workspace_peers
    const { data: peer } = await db.from('workspace_peers')
      .select('id, name')
      .eq('our_token', peerToken)
      .eq('status', 'connected')
      .maybeSingle();

    if (!peer) {
      res.status(403).json({ error: 'Invalid or expired peer token' });
      return;
    }

    const { query, workspaceId, maxChunks, tokenBudget } = req.body as {
      query?: string;
      workspaceId?: string;
      maxChunks?: number;
      tokenBudget?: number;
    };

    if (!query || !workspaceId) {
      res.status(400).json({ error: 'query and workspaceId are required' });
      return;
    }

    try {
      const chunks = await retrieveKnowledgeChunks({
        db,
        workspaceId,
        agentId: '__orchestrator__',
        query,
        tokenBudget: tokenBudget ?? 4000,
        maxChunks: maxChunks ?? 5,
        ollamaUrl: config.ollamaUrl,
        bm25Weight: config.ragBm25Weight,
        expandQueries: !!config.ollamaUrl,
        ollamaModel: config.ollamaModel,
        rerankerEnabled: config.rerankerEnabled,
      });

      logger.debug(
        { peerId: (peer as Record<string, unknown>).id, query: query.slice(0, 80), chunkCount: chunks.length },
        '[MeshRAG] Served peer RAG query',
      );

      res.json({ chunks });
    } catch (err) {
      logger.error({ err }, '[MeshRAG] Query failed');
      res.status(500).json({ error: 'RAG query failed' });
    }
  });

  return router;
}
