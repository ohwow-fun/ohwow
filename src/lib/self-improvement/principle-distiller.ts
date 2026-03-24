/**
 * Principle Distiller (E26) — Strategic Principle Extraction
 *
 * Groups semantic memories by theme and uses LLM to extract abstract
 * strategic principles. These principles are injected into agent
 * prompts as high-level guidance.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ModelRouter } from '../../execution/model-router.js';
import type { DistillationResult } from './types.js';
import { callLLM, parseJSONResponse, extractKeywords, keywordOverlap, calculateCostCents } from './llm-helper.js';
import { logger } from '../logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const MIN_MEMORIES_FOR_DISTILLATION = 5;
const MAX_MEMORIES_PER_PASS = 50;
const MIN_GROUP_SIZE = 3;
const MAX_PRINCIPLES_PER_RUN = 5;
const SEMANTIC_TYPES = ['fact', 'skill'];

// ============================================================================
// TYPES
// ============================================================================

interface MemoryRow {
  id: string;
  content: string;
  memory_type: string;
  is_active: number;
  relevance_score: number;
}

interface MemoryGroup {
  theme: string;
  memories: MemoryRow[];
}

// ============================================================================
// GROUPING
// ============================================================================

function groupMemories(memories: MemoryRow[]): MemoryGroup[] {
  const groups: MemoryGroup[] = [];
  const assigned = new Set<string>();

  const keywordsMap = memories.map((m) => ({
    memory: m,
    keywords: extractKeywords(m.content),
  }));

  for (const { memory, keywords } of keywordsMap) {
    if (assigned.has(memory.id)) continue;

    const group: MemoryRow[] = [memory];
    assigned.add(memory.id);

    for (const { memory: other, keywords: otherKw } of keywordsMap) {
      if (assigned.has(other.id)) continue;
      if (keywordOverlap(keywords, otherKw) >= 0.25) {
        group.push(other);
        assigned.add(other.id);
      }
    }

    if (group.length >= MIN_GROUP_SIZE) {
      const allKw = group.flatMap((m) => extractKeywords(m.content));
      const counts = new Map<string, number>();
      for (const kw of allKw) counts.set(kw, (counts.get(kw) || 0) + 1);
      const topKw = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([kw]) => kw);

      groups.push({ theme: topKw.join(', '), memories: group });
    }
  }

  return groups;
}

// ============================================================================
// PROMPTS
// ============================================================================

const DISTILLATION_SYSTEM_PROMPT = `You are a strategic principle extractor. Given a group of related semantic memories from an AI agent, extract 1-2 abstract strategic principles.

Respond with ONLY a JSON array of objects:
[{"rule": "principle text", "category": "category_name"}]

Categories: tool_usage, communication, data_handling, workflow, safety, strategy

Rules:
- Principles should be ABSTRACT and STRATEGIC, not tactical
- "Always verify before acting" is better than "Check email addresses before sending"
- Each principle should be 1 sentence, actionable, and universally applicable
- If the memories don't share a meaningful strategic pattern, return []
- Maximum 2 principles per group`;

function buildDistillationPrompt(group: MemoryGroup): string {
  const memories = group.memories
    .map((m) => `- [${m.memory_type}] ${m.content}`)
    .join('\n');

  return `Theme: ${group.theme}

Semantic memories (${group.memories.length}):
${memories}

Extract strategic principles from these patterns.`;
}

// ============================================================================
// MAIN DISTILLER
// ============================================================================

/**
 * Distill strategic principles from an agent's semantic memories.
 */
export async function distillPrinciples(
  db: DatabaseAdapter,
  router: ModelRouter,
  workspaceId: string,
  agentId: string
): Promise<DistillationResult> {
  // Fetch semantic memories
  const { data: allMemories } = await db
    .from<MemoryRow>('agent_workforce_agent_memory')
    .select('id, content, memory_type, is_active, relevance_score')
    .eq('workspace_id', workspaceId)
    .eq('agent_id', agentId)
    .eq('is_active', 1)
    .limit(100);

  const semantic = (allMemories ?? []).filter(
    (m) => SEMANTIC_TYPES.includes(m.memory_type)
  );

  if (semantic.length < MIN_MEMORIES_FOR_DISTILLATION) {
    return { memoriesAnalyzed: semantic.length, groupsFormed: 0, principlesCreated: 0, duplicatesSkipped: 0, tokensUsed: 0, costCents: 0 };
  }

  const toProcess = semantic.slice(0, MAX_MEMORIES_PER_PASS);
  const groups = groupMemories(toProcess);

  if (groups.length === 0) {
    return { memoriesAnalyzed: toProcess.length, groupsFormed: 0, principlesCreated: 0, duplicatesSkipped: 0, tokensUsed: 0, costCents: 0 };
  }

  // Fetch existing principles for dedup
  const { data: existingPrinciples } = await db
    .from('agent_workforce_principles')
    .select('rule')
    .eq('workspace_id', workspaceId)
    .eq('is_active', 1);

  const existingRules = new Set(
    (existingPrinciples ?? []).map((p) => ((p as Record<string, unknown>).rule as string).toLowerCase())
  );

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let principlesCreated = 0;
  let duplicatesSkipped = 0;

  for (const group of groups.slice(0, MAX_PRINCIPLES_PER_RUN)) {
    const result = await callLLM(router, {
      system: DISTILLATION_SYSTEM_PROMPT,
      userMessage: buildDistillationPrompt(group),
      maxTokens: 300,
      temperature: 0.3,
    });

    if (!result.success) {
      logger.error({ error: result.error }, '[PrincipleDistiller] LLM call failed');
      continue;
    }

    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;

    const principles = parseJSONResponse<Array<{ rule: string; category: string }>>(result.content);
    if (!principles || !Array.isArray(principles)) continue;

    const validPrinciples = principles
      .filter((item) => item && typeof item.rule === 'string' && typeof item.category === 'string')
      .slice(0, 2);

    for (const principle of validPrinciples) {
      if (existingRules.has(principle.rule.toLowerCase())) {
        duplicatesSkipped++;
        continue;
      }

      const validCategories = ['tool_usage', 'communication', 'data_handling', 'workflow', 'safety', 'strategy'];
      const category = validCategories.includes(principle.category) ? principle.category : 'strategy';

      const avgRelevance = group.memories.reduce((sum, m) => sum + m.relevance_score, 0) / group.memories.length;
      const confidence = Math.min(1, avgRelevance * (group.memories.length / 10));

      try {
        await db
          .from('agent_workforce_principles')
          .insert({
            workspace_id: workspaceId,
            agent_id: agentId,
            rule: principle.rule,
            category,
            confidence,
            utility_score: 0,
            source_memory_ids: JSON.stringify(group.memories.map((m) => m.id)),
            times_applied: 0,
            is_active: 1,
          });

        principlesCreated++;
        existingRules.add(principle.rule.toLowerCase());
        logger.info({ rule: principle.rule, category, confidence, agentId }, '[PrincipleDistiller] Principle distilled');
      } catch (err) {
        logger.error({ err, rule: principle.rule }, '[PrincipleDistiller] Couldn\'t create principle');
      }
    }
  }

  const costCents = calculateCostCents(totalInputTokens, totalOutputTokens);

  return {
    memoriesAnalyzed: toProcess.length,
    groupsFormed: groups.length,
    principlesCreated,
    duplicatesSkipped,
    tokensUsed: totalInputTokens + totalOutputTokens,
    costCents,
  };
}
