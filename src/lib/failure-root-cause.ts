/**
 * Failure Root-Cause Tagging — Semantic failure classification via LLM.
 *
 * Unlike error-classification.ts (which pattern-matches on error messages
 * for infrastructure failures like timeouts and rate limits), this module
 * classifies the *semantic* root cause of why a task failed to produce
 * the desired outcome. Uses a lightweight LLM call.
 *
 * Root cause categories:
 * - wrong_tool: Agent selected inappropriate tools for the task
 * - bad_input: Task input was ambiguous, incomplete, or malformed
 * - integration_error: External service/API failure
 * - prompt_insufficient: Agent's system prompt lacks guidance for this task type
 * - impossible_task: Task cannot be accomplished with available tools/data
 *
 * Results feed into the improvement cycle for prompt evolution and
 * agent gap analysis.
 */

import type { ModelRouter } from '../execution/model-router.js';
import { logger } from './logger.js';

export type RootCause =
  | 'wrong_tool'
  | 'bad_input'
  | 'integration_error'
  | 'prompt_insufficient'
  | 'impossible_task'
  | 'unknown';

const ROOT_CAUSE_PROMPT = `You are a failure analysis system. Given a failed task's title, input, error message, and tools used, classify the root cause into exactly one of these categories:

- wrong_tool: The agent used inappropriate tools for the task
- bad_input: The task input was ambiguous, incomplete, or malformed
- integration_error: An external service, API, or integration failed
- prompt_insufficient: The agent's instructions lack guidance for this task type
- impossible_task: The task cannot be accomplished with available tools/data

Respond with ONLY the category name, nothing else.`;

export interface FailureContext {
  taskTitle: string;
  taskInput: string;
  errorMessage: string;
  toolsUsed?: string[];
}

/**
 * Classify the root cause of a task failure using a lightweight LLM call.
 * Returns 'unknown' if classification fails or times out.
 */
export async function classifyRootCause(
  modelRouter: ModelRouter,
  context: FailureContext,
): Promise<RootCause> {
  try {
    const provider = await modelRouter.getProvider('memory_extraction');

    const userMessage = [
      `Task: ${context.taskTitle}`,
      `Input: ${(context.taskInput || '').slice(0, 300)}`,
      `Error: ${context.errorMessage.slice(0, 300)}`,
      context.toolsUsed?.length ? `Tools used: ${context.toolsUsed.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const response = await provider.createMessage({
      system: ROOT_CAUSE_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: 20,
      temperature: 0,
    });

    const category = response.content.trim().toLowerCase() as RootCause;
    const validCategories: RootCause[] = [
      'wrong_tool', 'bad_input', 'integration_error',
      'prompt_insufficient', 'impossible_task',
    ];

    if (validCategories.includes(category)) {
      return category;
    }

    // Try to match partial response
    for (const valid of validCategories) {
      if (response.content.toLowerCase().includes(valid)) {
        return valid;
      }
    }

    return 'unknown';
  } catch (err) {
    logger.debug({ err }, '[RootCause] Classification failed, returning unknown');
    return 'unknown';
  }
}
