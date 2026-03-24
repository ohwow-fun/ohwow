/**
 * Memory Consolidation — Local Workspace
 *
 * Clusters related memories using Jaccard similarity and produces
 * consolidated summaries via Anthropic Haiku. Adapted from the cloud
 * version for the local SQLite-backed runtime.
 */

import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { jaccardSimilarity } from './memory-utils.js';

// ============================================================================
// TYPES
// ============================================================================

interface MemoryRow {
  id: string;
  agent_id: string;
  workspace_id: string;
  memory_type: string;
  content: string;
  relevance_score: number;
  source_type: string;
  trust_level: string;
}

export interface ConsolidationResult {
  clustersFound: number;
  memoriesConsolidated: number;
  summariesCreated: number;
}

// ============================================================================
// CLUSTERING
// ============================================================================

const SIMILARITY_THRESHOLD = 0.6;
const MIN_CLUSTER_SIZE = 3;

interface MemoryCluster {
  memories: MemoryRow[];
  avgSimilarity: number;
}

function findClusters(memories: MemoryRow[]): MemoryCluster[] {
  const clusters: MemoryCluster[] = [];
  const assigned = new Set<string>();

  for (let i = 0; i < memories.length; i++) {
    if (assigned.has(memories[i].id)) continue;

    const cluster: MemoryRow[] = [memories[i]];
    const similarities: number[] = [];

    for (let j = i + 1; j < memories.length; j++) {
      if (assigned.has(memories[j].id)) continue;

      const sim = jaccardSimilarity(memories[i].content, memories[j].content);
      if (sim >= SIMILARITY_THRESHOLD) {
        cluster.push(memories[j]);
        similarities.push(sim);
      }
    }

    if (cluster.length >= MIN_CLUSTER_SIZE) {
      for (const m of cluster) assigned.add(m.id);
      const avgSim = similarities.length > 0
        ? similarities.reduce((a, b) => a + b, 0) / similarities.length
        : SIMILARITY_THRESHOLD;
      clusters.push({ memories: cluster, avgSimilarity: avgSim });
    }
  }

  return clusters;
}

// ============================================================================
// CONSOLIDATION
// ============================================================================

/**
 * Consolidate related memories for an agent in local SQLite.
 */
export async function consolidateMemoriesLocal(
  db: DatabaseAdapter,
  workspaceId: string,
  agentId: string,
  anthropicApiKey: string,
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    clustersFound: 0,
    memoriesConsolidated: 0,
    summariesCreated: 0,
  };

  // Fetch active inferred memories
  const { data } = await db
    .from<MemoryRow>('agent_workforce_agent_memory')
    .select('id, agent_id, workspace_id, memory_type, content, relevance_score, source_type, trust_level')
    .eq('agent_id', agentId)
    .eq('is_active', 1)
    .eq('trust_level', 'inferred');

  if (!data || data.length < MIN_CLUSTER_SIZE) return result;
  const memories = data ?? [];

  // Group by type
  const byType = new Map<string, MemoryRow[]>();
  for (const m of memories) {
    const group = byType.get(m.memory_type) ?? [];
    group.push(m);
    byType.set(m.memory_type, group);
  }

  const client = new Anthropic({ apiKey: anthropicApiKey });

  for (const [type, typeMemories] of byType) {
    if (typeMemories.length < MIN_CLUSTER_SIZE) continue;

    const clusters = findClusters(typeMemories);
    result.clustersFound += clusters.length;

    for (const cluster of clusters) {
      const consolidationGroupId = crypto.randomUUID();
      const memoryList = cluster.memories.map((m) => `- ${m.content}`).join('\n');

      try {
        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          temperature: 0.2,
          system: 'You consolidate overlapping memories into fewer, more comprehensive ones. Respond with ONLY a JSON array of strings.',
          messages: [
            {
              role: 'user',
              content: `These related ${type} memories share overlapping information. Consolidate them into 1-2 concise memories that capture all key information without redundancy.

Memories:
${memoryList}

Return a JSON array of 1-2 consolidated memory strings.`,
            },
          ],
        });

        const textContent = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');

        let raw = textContent.trim();
        const fenceMatch = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)```$/);
        if (fenceMatch) raw = fenceMatch[1].trim();

        const summaries = JSON.parse(raw) as unknown[];
        const validSummaries = summaries
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .slice(0, 2);

        if (validSummaries.length === 0) continue;

        const maxRelevance = Math.max(...cluster.memories.map((m) => m.relevance_score));

        // Insert consolidated summaries
        for (const summary of validSummaries) {
          await db.from('agent_workforce_agent_memory').insert({
            id: crypto.randomUUID(),
            agent_id: agentId,
            workspace_id: workspaceId,
            memory_type: type,
            content: summary.trim(),
            source_type: 'extraction',
            trust_level: 'inferred',
            relevance_score: maxRelevance,
            consolidation_group_id: consolidationGroupId,
            is_active: 1,
            times_used: 0,
            token_count: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          result.summariesCreated++;
        }

        // Supersede originals
        for (const m of cluster.memories) {
          await db.from('agent_workforce_agent_memory')
            .update({
              is_active: 0,
              superseded_by: consolidationGroupId,
              updated_at: new Date().toISOString(),
            })
            .eq('id', m.id);
          result.memoriesConsolidated++;
        }
      } catch {
        // Non-fatal: skip this cluster on error
        continue;
      }
    }
  }

  return result;
}
