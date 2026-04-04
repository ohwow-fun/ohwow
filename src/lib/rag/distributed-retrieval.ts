/**
 * Distributed RAG Retrieval — Mesh-aware knowledge retrieval across peer devices.
 * A document on your laptop can answer a question from your desktop.
 *
 * All mesh operations are best-effort with graceful fallback to local-only results.
 */

import { logger } from '../logger.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { RagChunk } from './retrieval.js';

// ============================================================================
// TYPES
// ============================================================================

export interface DistributedRetrievalOptions {
  db: DatabaseAdapter;
  workspaceId: string;
  query: string;
  maxPeers?: number;      // default 3
  timeout?: number;        // default 10_000ms
  tokenBudget?: number;    // default 4000
  maxChunks?: number;      // default 5
}

export interface DistributedResult {
  chunks: RagChunk[];
  peerSources: Array<{ peerId: string; peerName: string; chunkCount: number }>;
}

interface PeerRow {
  id: string;
  name: string;
  base_url: string;
  peer_token: string;
  last_seen_at: string | null;
  knowledge_chunk_count: number | null;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const STALE_PEER_MS = 60_000;
const REMOTE_SCORE_PENALTY = 0.9;

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Query knowledge chunks from connected mesh peers.
 * Results are score-penalized (0.9x) relative to local chunks to prefer local data.
 */
export async function retrieveFromMesh(opts: DistributedRetrievalOptions): Promise<DistributedResult> {
  const {
    db,
    workspaceId,
    query,
    maxPeers = 3,
    timeout = 10_000,
    tokenBudget = 4000,
    maxChunks = 5,
  } = opts;

  // 1. Get active peers
  const { data: peers } = await db
    .from<PeerRow>('workspace_peers')
    .select('id, name, base_url, peer_token, last_seen_at, knowledge_chunk_count')
    .eq('status', 'connected');

  if (!peers || peers.length === 0) {
    return { chunks: [], peerSources: [] };
  }

  // 2. Filter: only peers seen in last 60 seconds, with knowledge chunks
  const now = Date.now();
  const activePeers = peers.filter((p) => {
    if (!p.last_seen_at) return false;
    const age = now - new Date(p.last_seen_at).getTime();
    if (age > STALE_PEER_MS) return false;
    // If column exists and is 0, skip this peer (no knowledge)
    if (p.knowledge_chunk_count !== null && p.knowledge_chunk_count !== undefined && p.knowledge_chunk_count <= 0) return false;
    return true;
  });

  if (activePeers.length === 0) {
    return { chunks: [], peerSources: [] };
  }

  // 3. Sort by knowledge_chunk_count desc, take top N
  const sorted = [...activePeers].sort((a, b) => {
    const aCount = a.knowledge_chunk_count ?? 0;
    const bCount = b.knowledge_chunk_count ?? 0;
    return bCount - aCount;
  });
  const selectedPeers = sorted.slice(0, maxPeers);

  // 4. Query each peer in parallel
  const peerSources: DistributedResult['peerSources'] = [];
  const allChunks: RagChunk[] = [];

  const results = await Promise.allSettled(
    selectedPeers.map(async (peer) => {
      const response = await fetch(`${peer.base_url}/api/rag/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Peer-Token': peer.peer_token,
        },
        signal: AbortSignal.timeout(timeout),
        body: JSON.stringify({
          query,
          workspaceId,
          maxChunks,
          tokenBudget,
        }),
      });

      if (!response.ok) {
        logger.debug({ peerId: peer.id, status: response.status }, '[MeshRAG] Peer returned error');
        return { peerId: peer.id, peerName: peer.name, chunks: [] as RagChunk[] };
      }

      const data = await response.json() as { chunks?: RagChunk[] };
      return {
        peerId: peer.id,
        peerName: peer.name,
        chunks: data.chunks ?? [],
      };
    }),
  );

  // 5. Collect results from successful fetches
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { peerId, peerName, chunks } = result.value;
      if (chunks.length > 0) {
        peerSources.push({ peerId, peerName, chunkCount: chunks.length });
        for (const chunk of chunks) {
          // Apply score penalty to remote chunks
          allChunks.push({
            ...chunk,
            score: chunk.score * REMOTE_SCORE_PENALTY,
          });
        }
      }
    } else {
      logger.debug({ error: result.reason }, '[MeshRAG] Peer query failed');
    }
  }

  // 6. Dedup by content prefix (first 100 chars)
  const seen = new Set<string>();
  const deduped: RagChunk[] = [];
  for (const chunk of allChunks) {
    const key = chunk.content.slice(0, 100);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(chunk);
    }
  }

  // 7. Sort by score desc
  deduped.sort((a, b) => b.score - a.score);

  return { chunks: deduped, peerSources };
}
