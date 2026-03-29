/**
 * Dialectic — Counter-Plan Synthesis (Hegel)
 *
 * "The truth is the whole. But the whole is nothing other than
 * the essence consummating itself through its development."
 * — G.W.F. Hegel, Phenomenology of Spirit
 *
 * Hegel's dialectic:
 * - Thesis: the initial plan
 * - Antithesis: what could go wrong?
 * - Synthesis: a stronger plan that addresses the counter-argument
 *
 * For simple plans (1-2 steps), no dialectic is needed.
 * For complex plans (3+ steps, planFirst=true), generating a brief
 * counter-argument catches wrong-direction errors before expensive
 * multi-step execution begins.
 *
 * Cost: 1 Haiku call (~300 tokens input, ~100 output = ~0.01 cents)
 * Saves: entire failed multi-step execution (~0.5-2 cents, 5-10 tool calls)
 */

import type { ModelRouter } from '../execution/model-router.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface DialecticResult {
  /** Whether the dialectic was applied. */
  applied: boolean;
  /** The counter-argument (antithesis). null if plan seems solid. */
  counterArgument: string | null;
  /** Token cost of the dialectic check. */
  tokensUsed: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DIALECTIC_SYSTEM_PROMPT = `You are a critical thinking module. Given a plan, identify the single most likely failure point.

Rules:
- Be specific and actionable (not vague warnings)
- Focus on the MOST likely failure, not all possible failures
- If the plan seems solid, respond with just "SOLID"
- Keep your response under 2 sentences
- Don't suggest an entirely different approach — just flag the risk`;

/** Minimum plan steps to trigger dialectic analysis. */
const MIN_STEPS_FOR_DIALECTIC = 3;

// ============================================================================
// DIALECTIC ENGINE
// ============================================================================

/**
 * Generate a counter-argument for a complex plan.
 *
 * Only activates for plans with 3+ steps. For simpler plans,
 * returns immediately with applied: false.
 *
 * @param planDescription - Human-readable description of the planned steps
 * @param planStepCount - Number of steps in the plan
 * @param modelRouter - For making the LLM call
 * @param userMessage - The original user request (for context)
 */
export async function dialecticCheck(
  planDescription: string,
  planStepCount: number,
  modelRouter: ModelRouter | null,
  userMessage: string,
): Promise<DialecticResult> {
  // Skip for simple plans
  if (planStepCount < MIN_STEPS_FOR_DIALECTIC) {
    return { applied: false, counterArgument: null, tokensUsed: 0 };
  }

  // Need a model router to make the LLM call
  if (!modelRouter) {
    return { applied: false, counterArgument: null, tokensUsed: 0 };
  }

  try {
    const provider = await modelRouter.getProvider('memory_extraction'); // use cheapest model
    const response = await provider.createMessage({
      system: DIALECTIC_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `User request: "${userMessage.slice(0, 200)}"\n\nProposed plan:\n${planDescription}`,
      }],
      maxTokens: 150,
      temperature: 0.3,
    });

    const content = response.content.trim();
    const tokensUsed = response.inputTokens + response.outputTokens;

    // If the model thinks the plan is solid, no counter-argument
    if (content.toUpperCase().includes('SOLID')) {
      logger.debug('[Dialectic] Plan assessed as solid');
      return { applied: true, counterArgument: null, tokensUsed };
    }

    logger.info({ counterArgument: content.slice(0, 100) }, '[Dialectic] Counter-argument generated');
    return { applied: true, counterArgument: content, tokensUsed };
  } catch (err) {
    logger.error({ err }, '[Dialectic] Failed to generate counter-argument');
    return { applied: false, counterArgument: null, tokensUsed: 0 };
  }
}

/**
 * Format a dialectic counter-argument for injection into the LLM context.
 */
export function formatDialecticWarning(counterArgument: string): string {
  return `[DIALECTIC CHECK] Before proceeding with your multi-step plan, consider this risk: ${counterArgument}. Address this concern in your approach or explain why it doesn't apply.`;
}
