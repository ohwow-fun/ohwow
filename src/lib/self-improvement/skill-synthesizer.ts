/**
 * Skill Synthesizer (E22) — Auto-Create Skills from Mined Patterns
 *
 * Takes mined tool-call patterns and uses LLM to generate
 * skill metadata (name, description, preconditions, effects).
 * Deduplicates against existing skills and creates new ones.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ModelRouter } from '../../execution/model-router.js';
import type { MinedPattern, SynthesizedSkillMetadata, SynthesisResult } from './types.js';
import { callLLM, parseJSONResponse, calculateCostCents } from './llm-helper.js';
import { logger } from '../logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_SKILLS_PER_RUN = 5;

// ============================================================================
// PROMPTS
// ============================================================================

const SYNTHESIS_SYSTEM_PROMPT = `You are a skill synthesis system. Given a recurring tool-call pattern from an AI agent's execution history, generate a named skill with metadata.

Respond with ONLY a JSON object:
{
  "name": "short_snake_case_name",
  "description": "1-2 sentence description of what this skill accomplishes",
  "preconditions": ["condition that must be true before using this skill"],
  "effects": ["outcome after successful execution"]
}

Rules:
- Name should be descriptive and unique (e.g., "verify_then_send_email", "research_and_summarize")
- Preconditions describe what inputs or state are needed
- Effects describe what changes after successful execution
- Be concise and actionable
- Focus on the BUSINESS PURPOSE, not the technical tool names`;

function buildSynthesisPrompt(pattern: MinedPattern): string {
  return `Tool sequence pattern (appears in ${pattern.support} tasks, ${Math.round(pattern.avgSuccessRate * 100)}% success rate):

${pattern.toolSequence.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Generate a named skill for this pattern.`;
}

// ============================================================================
// DEDUPLICATION
// ============================================================================

interface ExistingSkill {
  id: string;
  definition: { tool_sequence?: string[] };
}

function isDuplicate(pattern: MinedPattern, existingSkills: ExistingSkill[]): boolean {
  for (const skill of existingSkills) {
    const existingSequence = skill.definition.tool_sequence;
    if (!existingSequence || existingSequence.length === 0) continue;

    if (
      existingSequence.length === pattern.toolSequence.length &&
      existingSequence.every((t, i) => t === pattern.toolSequence[i])
    ) {
      return true;
    }

    const overlapCount = pattern.toolSequence.filter((t) => existingSequence.includes(t)).length;
    const overlapRatio = overlapCount / Math.max(pattern.toolSequence.length, existingSequence.length);
    if (overlapRatio >= 0.8) return true;
  }

  return false;
}

// ============================================================================
// MAIN SYNTHESIZER
// ============================================================================

/**
 * Synthesize skills from mined patterns.
 */
export async function synthesizeSkills(
  db: DatabaseAdapter,
  router: ModelRouter,
  workspaceId: string,
  agentId: string,
  patterns: MinedPattern[]
): Promise<SynthesisResult> {
  if (patterns.length === 0) {
    return { tracesAnalyzed: 0, patternsFound: 0, skillsCreated: 0, duplicatesSkipped: 0, tokensUsed: 0, costCents: 0 };
  }

  // Fetch existing skills for dedup
  const { data: existingData } = await db
    .from('agent_workforce_skills')
    .select('id, definition')
    .eq('workspace_id', workspaceId)
    .eq('is_active', 1);

  const existingSkills: ExistingSkill[] = (existingData ?? []).map((d) => {
    const row = d as Record<string, unknown>;
    let definition: { tool_sequence?: string[] } = {};
    try {
      definition = typeof row.definition === 'string' ? JSON.parse(row.definition) : (row.definition as { tool_sequence?: string[] }) || {};
    } catch { /* empty */ }
    return { id: row.id as string, definition };
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let skillsCreated = 0;
  let duplicatesSkipped = 0;

  const toProcess = patterns.slice(0, MAX_SKILLS_PER_RUN);

  for (const pattern of toProcess) {
    if (isDuplicate(pattern, existingSkills)) {
      duplicatesSkipped++;
      continue;
    }

    const result = await callLLM(router, {
      system: SYNTHESIS_SYSTEM_PROMPT,
      userMessage: buildSynthesisPrompt(pattern),
      maxTokens: 300,
      temperature: 0.3,
    });

    if (!result.success) {
      logger.error({ error: result.error }, '[SkillSynthesizer] LLM call failed');
      continue;
    }

    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;

    const metadata = parseJSONResponse<SynthesizedSkillMetadata>(result.content);
    if (!metadata || !metadata.name || !metadata.description) {
      logger.error({ content: result.content }, '[SkillSynthesizer] Invalid metadata response');
      continue;
    }

    try {
      const definition = JSON.stringify({
        prompt_template: metadata.description,
        tool_sequence: pattern.toolSequence,
        preconditions: metadata.preconditions,
        effects: metadata.effects,
        verification_criteria: [],
      });

      await db
        .from('agent_workforce_skills')
        .insert({
          workspace_id: workspaceId,
          name: metadata.name,
          description: metadata.description,
          skill_type: 'procedure',
          source_type: 'synthesized',
          definition,
          agent_ids: JSON.stringify([agentId]),
          pattern_support: pattern.support,
        });

      skillsCreated++;
      logger.info({ skillName: metadata.name, support: pattern.support, agentId }, '[SkillSynthesizer] Skill synthesized');
    } catch (err) {
      logger.error({ err, skillName: metadata.name }, '[SkillSynthesizer] Couldn\'t create skill');
    }
  }

  const costCents = calculateCostCents(totalInputTokens, totalOutputTokens);

  return {
    tracesAnalyzed: patterns.length > 0 ? patterns[0].sourceTaskIds.length : 0,
    patternsFound: patterns.length,
    skillsCreated,
    duplicatesSkipped,
    tokensUsed: totalInputTokens + totalOutputTokens,
    costCents,
  };
}
