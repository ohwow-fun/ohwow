/**
 * Memory Compression (E13) — Episodic → Semantic Distillation
 *
 * Implements a compression layer that distills patterns from multiple
 * episodic memories into generalized semantic knowledge. Part of
 * the 3-layer memory architecture inspired by AOI (arXiv:2512.13956).
 *
 * @see https://arxiv.org/abs/2512.13956
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ModelRouter } from '../../execution/model-router.js';
import type { CompressionResult } from './types.js';
import { callLLM, parseJSONResponse, extractKeywords, keywordOverlap, calculateCostCents } from './llm-helper.js';
import { logger } from '../logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const MIN_EPISODIC_FOR_COMPRESSION = 5;
const MAX_EPISODIC_PER_PASS = 30;
const MIN_GROUP_SIZE = 3;

/** Memory types eligible for compression */
const COMPRESSIBLE_TYPES = ['fact', 'skill', 'feedback_positive', 'feedback_negative'];

// ============================================================================
// TYPES
// ============================================================================

interface MemoryRow {
  id: string;
  content: string;
  memory_type: string;
  is_active: number;
  created_at: string;
  relevance_score: number;
}

interface EpisodicGroup {
  theme: string;
  memories: MemoryRow[];
}

// ============================================================================
// GROUPING
// ============================================================================

function groupEpisodicMemories(memories: MemoryRow[]): EpisodicGroup[] {
  const groups: EpisodicGroup[] = [];
  const assigned = new Set<string>();

  const memoryKeywords = memories.map((m) => ({
    memory: m,
    keywords: extractKeywords(m.content),
  }));

  for (const { memory, keywords } of memoryKeywords) {
    if (assigned.has(memory.id)) continue;

    const group: MemoryRow[] = [memory];
    assigned.add(memory.id);

    for (const { memory: other, keywords: otherKeywords } of memoryKeywords) {
      if (assigned.has(other.id)) continue;
      if (keywordOverlap(keywords, otherKeywords) >= 0.3) {
        group.push(other);
        assigned.add(other.id);
      }
    }

    if (group.length >= MIN_GROUP_SIZE) {
      const allKeywords = group.flatMap((m) => extractKeywords(m.content));
      const counts = new Map<string, number>();
      for (const kw of allKeywords) counts.set(kw, (counts.get(kw) || 0) + 1);
      const topKeywords = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([kw]) => kw);

      groups.push({ theme: topKeywords.join(', '), memories: group });
    }
  }

  return groups;
}

// ============================================================================
// PROMPTS
// ============================================================================

const COMPRESSION_SYSTEM_PROMPT = `You are a memory compression system. Given a group of related episodic memories from an AI agent, distill them into 1-2 concise semantic memories that capture the generalized knowledge.

Respond with ONLY a JSON array of objects, each with:
- "type": one of "fact", "skill" (the semantic type)
- "content": a concise, generalized memory (1-2 sentences)

Rules:
- Distill the PATTERN across episodes, not individual events
- Generalize: "When X happens, do Y" is better than "On March 5th, I did Z"
- Preserve critical information (tools, conditions, outcomes)
- Maximum 2 output memories per group
- If the episodes don't share a meaningful pattern, return []`;

function buildCompressionPrompt(group: EpisodicGroup): string {
  const memories = group.memories
    .map((m) => `- [${m.memory_type}] ${m.content}`)
    .join('\n');

  return `Theme: ${group.theme}

Episodic memories (${group.memories.length}):
${memories}

Distill these into generalized knowledge.`;
}

// ============================================================================
// MAIN COMPRESSION
// ============================================================================

/**
 * Run a compression pass for an agent's episodic memories.
 */
export async function compressEpisodicMemories(
  db: DatabaseAdapter,
  router: ModelRouter,
  workspaceId: string,
  agentId: string
): Promise<CompressionResult> {
  // Fetch episodic memories
  const { data: allMemories } = await db
    .from<MemoryRow>('agent_workforce_agent_memory')
    .select('id, content, memory_type, is_active, created_at, relevance_score')
    .eq('workspace_id', workspaceId)
    .eq('agent_id', agentId)
    .eq('is_active', 1)
    .order('created_at', { ascending: true })
    .limit(100);

  const episodic = (allMemories ?? []).filter(
    (m) => COMPRESSIBLE_TYPES.includes(m.memory_type)
  );

  if (episodic.length < MIN_EPISODIC_FOR_COMPRESSION) {
    logger.debug({ agentId, episodicCount: episodic.length }, '[Compression] Not enough memories for compression');
    return { episodicAnalyzed: episodic.length, compressedCreated: 0, episodicSuperseded: 0, compressionRatio: 0, tokensUsed: 0, costCents: 0 };
  }

  const toProcess = episodic.slice(0, MAX_EPISODIC_PER_PASS);
  const groups = groupEpisodicMemories(toProcess);

  if (groups.length === 0) {
    return { episodicAnalyzed: toProcess.length, compressedCreated: 0, episodicSuperseded: 0, compressionRatio: 0, tokensUsed: 0, costCents: 0 };
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let compressedCreated = 0;
  let episodicSuperseded = 0;

  for (const group of groups) {
    const result = await callLLM(router, {
      system: COMPRESSION_SYSTEM_PROMPT,
      userMessage: buildCompressionPrompt(group),
      maxTokens: 300,
      temperature: 0.2,
    });

    if (!result.success) {
      logger.error({ error: result.error }, '[Compression] LLM call failed');
      continue;
    }

    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;

    const compressed = parseJSONResponse<Array<{ type: string; content: string }>>(result.content);
    if (!compressed || !Array.isArray(compressed) || compressed.length === 0) continue;

    const validItems = compressed
      .filter((item) => item && typeof item.type === 'string' && typeof item.content === 'string' && ['fact', 'skill'].includes(item.type))
      .slice(0, 2);

    if (validItems.length === 0) continue;

    // Create compressed memories
    for (const item of validItems) {
      await db
        .from('agent_workforce_agent_memory')
        .insert({
          agent_id: agentId,
          workspace_id: workspaceId,
          memory_type: item.type,
          content: item.content,
          source_type: 'extraction',
          relevance_score: 0.7,
        });
      compressedCreated++;
    }

    // Mark originals as superseded
    for (const memory of group.memories) {
      await db
        .from('agent_workforce_agent_memory')
        .update({ is_active: 0 })
        .eq('id', memory.id);
      episodicSuperseded++;
    }

    logger.debug({ theme: group.theme, compressed: validItems.length, superseded: group.memories.length }, '[Compression] Group compressed');
  }

  const costCents = calculateCostCents(totalInputTokens, totalOutputTokens);

  logger.info(
    { agentId, episodicAnalyzed: toProcess.length, groups: groups.length, compressedCreated, episodicSuperseded, costCents },
    '[Compression] Compression pass completed',
  );

  return {
    episodicAnalyzed: toProcess.length,
    compressedCreated,
    episodicSuperseded,
    compressionRatio: compressedCreated > 0 ? episodicSuperseded / compressedCreated : 0,
    tokensUsed: totalInputTokens + totalOutputTokens,
    costCents,
  };
}
