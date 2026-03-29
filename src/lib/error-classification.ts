/**
 * Error Classification (Local Runtime)
 * Categorize errors for analytics and debugging.
 * Ported from cloud: src/lib/agents/agent-runner-shared.ts
 */

export type FailureCategory =
  | 'grounding_error'
  | 'tool_error'
  | 'safety_error'
  | 'timeout'
  | 'budget_exceeded'
  | 'model_error'
  | 'unknown';

/**
 * Classify an error into a failure category for analytics and debugging.
 */
export function classifyError(error: unknown): FailureCategory {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();

  // Safety / content policy
  if (msg.includes('content policy') || msg.includes('safety') || msg.includes('harmful') || msg.includes('refused')) {
    return 'safety_error';
  }

  // Model / API errors
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('overloaded') || msg.includes('authentication') || msg.includes('unauthorized')) {
    return 'model_error';
  }

  // Grounding errors (unknown tools, hallucinated tool names)
  if (msg.includes('unknown tool') || msg.includes('not found') || msg.includes('no such tool')) {
    return 'grounding_error';
  }

  // Integration / tool execution errors
  if (msg.includes('gmail') || msg.includes('dropbox') || msg.includes('integration') || msg.includes('api error') || msg.includes('oauth')) {
    return 'tool_error';
  }

  // Timeout
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('deadline exceeded')) {
    return 'timeout';
  }

  // Budget / credits
  if (msg.includes('budget') || msg.includes('credit') || msg.includes('insufficient') || msg.includes('exceeded limit')) {
    return 'budget_exceeded';
  }

  return 'unknown';
}

/**
 * Whether a failure category should trigger automatic retry.
 * Retryable: rate limits (429), overloaded, timeouts.
 * Non-retryable: safety, grounding, budget, tool, unknown errors.
 */
export function isRetryableFailure(category: FailureCategory): boolean {
  return category === 'model_error' || category === 'timeout';
}
