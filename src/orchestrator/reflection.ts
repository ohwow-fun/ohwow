/**
 * Dynamic reflection prompt builder.
 * Replaces the static goal reminder with progress-aware re-anchoring.
 */

import type { ToolResult } from './local-tool-types.js';

/**
 * Build a reflection prompt that re-anchors the model to the original goal
 * with context about what has been accomplished so far.
 */
/** Max characters for the user message in reflection prompts after the first iteration. */
const USER_MESSAGE_TRUNCATE_LENGTH = 200;

export function buildReflectionPrompt(
  userMessage: string,
  executedToolCalls: Map<string, ToolResult>,
  iteration: number,
  maxIterations: number,
): string {
  // After the first iteration, truncate the user message to save tokens —
  // the full message is already in the conversation history.
  const displayMessage = iteration > 0 && userMessage.length > USER_MESSAGE_TRUNCATE_LENGTH
    ? userMessage.slice(0, USER_MESSAGE_TRUNCATE_LENGTH) + '...'
    : userMessage;
  const toolCount = executedToolCalls.size;

  // Build a concise summary of tools called and their outcomes
  const toolSummaryLines: string[] = [];
  for (const [key, result] of executedToolCalls) {
    const toolName = key.split(':')[0];
    const status = result.success ? 'OK' : 'FAILED';
    toolSummaryLines.push(`- ${toolName}: ${status}`);
  }

  // Keep tool summary concise — max 10 lines
  const toolSummary = toolSummaryLines.length > 10
    ? [...toolSummaryLines.slice(0, 9), `- ... and ${toolSummaryLines.length - 9} more tools`].join('\n')
    : toolSummaryLines.join('\n');

  const nearLimit = Math.floor(maxIterations * 0.8);
  const iterationWarning = iteration >= nearLimit
    ? ` You are near the iteration limit (${iteration + 1}/${maxIterations}). Prioritize synthesizing your answer now.`
    : '';

  const persistenceNote = iteration >= 2 && iteration < Math.floor(maxIterations * 0.5)
    ? ' You have plenty of iterations remaining. Be thorough: try multiple approaches, explore different strategies, and do not give up after a few failures.'
    : '';

  if (toolCount === 0) {
    return `[Original task: "${displayMessage}". No tools called yet. Choose the right tool to start, or answer directly if no tools are needed.]`;
  }

  return `[Tool results received. Progress so far (${toolCount} tool${toolCount !== 1 ? 's' : ''} called):
${toolSummary}

Original task: "${displayMessage}"

Decision: If you have enough information, write your final answer now. If you need MORE data, call another tool, or retry a previous one if conditions changed. Do NOT describe tool results — synthesize them into a useful answer.${persistenceNote}${iterationWarning}]`;
}
