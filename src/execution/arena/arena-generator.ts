/**
 * Arena Generator — Auto-generate arenas from descriptions
 *
 * Given a natural language description of what agents should practice,
 * uses an LLM to generate a complete ArenaConfig with appropriate
 * tool restrictions, success criteria, and reward functions.
 *
 * The generator introspects the body's affordances to know what tools
 * are actually available, ensuring generated arenas are executable.
 */

import type { ModelRouter } from '../model-router.js';
import type { Affordance } from '../../body/types.js';
import type { ArenaConfig, ArenaDomain } from './types.js';
import { toolSuccessReward, stepPenaltyReward, compositeReward } from './reward.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

/** LLM-generated arena specification (JSON output). */
interface GeneratedArenaSpec {
  name: string;
  description: string;
  domain: ArenaDomain;
  maxSteps: number;
  allowedTools: string[];
  successKeywords: string[];
  rewardStrategy: 'tool_success' | 'keyword_match' | 'composite';
}

// ============================================================================
// GENERATION
// ============================================================================

const GENERATION_PROMPT = `You are an arena designer for an AI agent training system.
Given a description of what an agent should practice, generate an arena specification.

Available tools the agent can use:
{TOOLS}

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "name": "short arena name",
  "description": "what the agent practices here",
  "domain": "browser" | "desktop" | "mcp" | "composite",
  "maxSteps": number (5-50, based on task complexity),
  "allowedTools": ["tool1", "tool2"] (subset of available tools relevant to this arena),
  "successKeywords": ["keyword1", "keyword2"] (words that indicate task completion in tool output),
  "rewardStrategy": "tool_success" | "keyword_match" | "composite"
}`;

/**
 * Generate an ArenaConfig from a natural language description.
 *
 * Uses an LLM to determine which tools are relevant, how many steps
 * are needed, and what success looks like. The generated config uses
 * simple keyword-based success criteria (not LLM-evaluated per step).
 */
export async function generateArenaFromDescription(
  description: string,
  modelRouter: ModelRouter,
  availableAffordances: Affordance[],
): Promise<ArenaConfig> {
  const toolList = availableAffordances
    .map(a => `- ${a.action} (${a.domain}, risk: ${a.risk})`)
    .join('\n');

  const prompt = GENERATION_PROMPT.replace('{TOOLS}', toolList);

  const provider = await modelRouter.getProvider('planning', 'simple');
  const response = await provider.createMessage({
    system: prompt,
    messages: [{ role: 'user', content: description }],
    maxTokens: 1024,
    temperature: 0.3,
  });

  const spec = parseSpec(response.content);

  // Filter allowed tools to only those that actually exist
  const validTools = new Set(availableAffordances.map(a => a.action));
  const allowedTools = spec.allowedTools.filter(t => validTools.has(t));

  // Build reward function based on strategy
  const rewardFn = buildRewardFn(spec);

  // Build success criteria from keywords
  const successCriteria = spec.successKeywords.length > 0
    ? (obs: { text?: string }) => {
        const text = (obs.text ?? '').toLowerCase();
        return spec.successKeywords.some(kw => text.includes(kw.toLowerCase()));
      }
    : undefined;

  const id = `generated-${Date.now().toString(36)}`;

  return {
    id,
    name: spec.name,
    description: spec.description,
    domain: spec.domain,
    maxSteps: Math.max(5, Math.min(50, spec.maxSteps)),
    rewardFn,
    successCriteria,
    allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

function parseSpec(content: string): GeneratedArenaSpec {
  // Try to extract JSON from the response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn('Arena generator: no JSON found in LLM response, using defaults');
    return defaultSpec();
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<GeneratedArenaSpec>;
    return {
      name: parsed.name ?? 'Generated Arena',
      description: parsed.description ?? 'Auto-generated training arena',
      domain: validateDomain(parsed.domain) ?? 'composite',
      maxSteps: typeof parsed.maxSteps === 'number' ? parsed.maxSteps : 20,
      allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
      successKeywords: Array.isArray(parsed.successKeywords) ? parsed.successKeywords : [],
      rewardStrategy: validateStrategy(parsed.rewardStrategy) ?? 'composite',
    };
  } catch {
    logger.warn('Arena generator: failed to parse LLM JSON, using defaults');
    return defaultSpec();
  }
}

function defaultSpec(): GeneratedArenaSpec {
  return {
    name: 'Generated Arena',
    description: 'Auto-generated training arena',
    domain: 'composite',
    maxSteps: 20,
    allowedTools: [],
    successKeywords: [],
    rewardStrategy: 'composite',
  };
}

function validateDomain(d: unknown): ArenaDomain | null {
  const valid: ArenaDomain[] = ['browser', 'desktop', 'mcp', 'composite'];
  return valid.includes(d as ArenaDomain) ? (d as ArenaDomain) : null;
}

function validateStrategy(s: unknown): GeneratedArenaSpec['rewardStrategy'] | null {
  const valid = ['tool_success', 'keyword_match', 'composite'];
  return valid.includes(s as string) ? (s as GeneratedArenaSpec['rewardStrategy']) : null;
}

function buildRewardFn(spec: GeneratedArenaSpec): ArenaConfig['rewardFn'] {
  switch (spec.rewardStrategy) {
    case 'tool_success':
      return toolSuccessReward();
    case 'keyword_match':
      return (obs) => {
        const text = (obs.text ?? '').toLowerCase();
        const matches = spec.successKeywords.filter(kw => text.includes(kw.toLowerCase()));
        return matches.length / Math.max(1, spec.successKeywords.length);
      };
    case 'composite':
    default:
      return compositeReward([
        { fn: toolSuccessReward(), weight: 0.7 },
        { fn: stepPenaltyReward(-0.02), weight: 0.3 },
      ]);
  }
}
