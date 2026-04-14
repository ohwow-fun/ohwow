/**
 * Per-iteration model selection for agent tool loops.
 *
 * Picks from the AGENT_MODEL_TIERS table below based on iteration index,
 * task difficulty, whether earlier iterations produced parse errors,
 * whether an SOP procedure is in the prompt, and whether vision is
 * required. No per-agent pin is consulted — the router owns this
 * decision entirely and only the OpenRouter provider participates;
 * every other provider returns undefined so it can use its own default.
 *
 * Extracted from RuntimeEngine so the tier constants + the selection
 * logic live next to each other instead of being split across a
 * module-top const and a private method 2800 lines below.
 */

import type { ModelProvider } from './model-router.js';
import type { DifficultyLevel } from './difficulty-scorer.js';

/**
 * Model tiers for per-iteration selection (from CURATED_OPENROUTER_MODELS).
 * Prioritize cost-effective models with reliable tool calling.
 */
export const AGENT_MODEL_TIERS = {
  FREE: 'xiaomi/mimo-v2-flash',             // FREE, 262K ctx, tools
  FAST: 'qwen/qwen3.5-35b-a3b',             // $0.16/$1.30 per M, 262K ctx, tools+vision. MoE w/ ~3B active params. Reliably emits OpenAI-format tool_calls — the 9B sibling returns text <function=...> pseudo-calls instead, which the router parses as 0 tool calls and trips the hallucination gate on work-shaped tasks.
  BALANCED: 'deepseek/deepseek-v3.2',       // $0.26/$0.38 per M, 163K ctx, tools
  STRONG: 'google/gemini-3.1-pro-preview',  // $2/$12 per M, 1M ctx, tools+vision, reliable tool calling
  VISION: 'google/gemini-3.1-flash-lite-preview', // 1M ctx, vision+tools, cheap
} as const;

/**
 * Select the best model string for a given agent tool-loop iteration.
 * Returns undefined for non-OpenRouter providers — they use their own
 * provider-default model and never consult this table.
 */
export function selectAgentModelForIteration(
  iteration: number,
  difficulty: DifficultyLevel | undefined,
  hasErrors: boolean,
  hasSOP: boolean,
  needsVision: boolean,
  provider: ModelProvider,
): string | undefined {
  // For non-OpenRouter providers, let them use their own default.
  if (provider.name !== 'openrouter') return undefined;

  // Vision-required: use a vision-capable model.
  if (needsVision) return AGENT_MODEL_TIERS.VISION;

  // SOP-driven tasks: stay on STRONG for the entire procedure. The SOP
  // has multi-step tool sequences (request_desktop → focus → type →
  // screenshot) and the model needs to continue calling tools, not just
  // summarize.
  if (hasSOP) {
    if (iteration <= 6) return AGENT_MODEL_TIERS.STRONG;
    return AGENT_MODEL_TIERS.FAST; // tail iterations for cleanup
  }

  // Iteration 0: quality matters most for initial reasoning + tool planning.
  if (iteration === 0) {
    if (difficulty === 'complex') return AGENT_MODEL_TIERS.STRONG;
    if (difficulty === 'moderate') return AGENT_MODEL_TIERS.BALANCED;
    return AGENT_MODEL_TIERS.FAST;
  }

  // Error recovery: escalate to balanced.
  if (hasErrors) return AGENT_MODEL_TIERS.BALANCED;

  // Later iterations: cheap tool-result routing.
  if (iteration >= 3) return AGENT_MODEL_TIERS.FREE;
  return AGENT_MODEL_TIERS.FAST;
}
