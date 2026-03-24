/**
 * Anthropic Claude AI Types (Runtime Copy)
 * ClaudeModel type and cost calculation for the local runtime.
 */

export type ClaudeModel = 'claude-sonnet-4-5' | 'claude-haiku-4';

/**
 * Token costs in cents per 1M tokens
 * Based on Claude pricing as of January 2025
 */
/**
 * Context window sizes (input tokens) per Claude model.
 * Single source of truth — all callers should import from here.
 */
export const CLAUDE_CONTEXT_LIMITS: Record<ClaudeModel, number> = {
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4': 200_000,
};

/**
 * Token costs in cents per 1M tokens
 * Based on Claude pricing as of January 2025
 */
export const CLAUDE_TOKEN_COSTS = {
  'claude-sonnet-4-5': {
    input: 300, // $3.00 per 1M input tokens
    output: 1500, // $15.00 per 1M output tokens
  },
  'claude-haiku-4': {
    input: 100, // $1.00 per 1M input tokens
    output: 500, // $5.00 per 1M output tokens
  },
} as const;

/**
 * Calculate cost in cents based on token usage
 */
export function calculateCostCents(
  model: ClaudeModel,
  inputTokens: number,
  outputTokens: number
): number {
  const costs = CLAUDE_TOKEN_COSTS[model];
  const inputCost = (inputTokens / 1_000_000) * costs.input;
  const outputCost = (outputTokens / 1_000_000) * costs.output;
  return Math.ceil(inputCost + outputCost);
}
