/**
 * Sandbox Executor (E25) — Run Agent with Mock Tool Responses
 *
 * Executes an agent against a training scenario with all integration
 * tools returning sandbox mock responses.
 */

import type { ModelRouter } from '../../execution/model-router.js';
import type { TrainingScenario, PracticeResult } from './types.js';
import { calculateCostCents } from './llm-helper.js';
import { logger } from '../logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_SANDBOX_ITERATIONS = 5;
const COST_CAP_CENTS = 5;
const SANDBOX_TOOL_RESPONSE = '[SANDBOX] Tool executed successfully. Simulated response: operation completed with expected results.';

// ============================================================================
// SANDBOX EXECUTION
// ============================================================================

/**
 * Execute a training scenario in sandbox mode.
 */
export async function executeSandbox(
  router: ModelRouter,
  scenario: TrainingScenario,
  agentSystemPrompt: string
): Promise<PracticeResult> {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolCallCount = 0;
  let finalOutput = '';

  const provider = await router.getProvider('memory_extraction');

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    {
      role: 'user',
      content: `[PRACTICE MODE] ${scenario.title}\n\n${scenario.description}\n\nNote: You are in practice mode. All tool calls will return simulated responses. Focus on demonstrating your reasoning and approach.`,
    },
  ];

  const sandboxSystemPrompt = `${agentSystemPrompt}\n\n[SANDBOX MODE] This is a practice session. All tool responses are simulated. Focus on demonstrating correct reasoning and tool selection.`;

  for (let iteration = 0; iteration < MAX_SANDBOX_ITERATIONS; iteration++) {
    const costSoFar = calculateCostCents(totalInputTokens, totalOutputTokens);
    if (costSoFar >= COST_CAP_CENTS) {
      logger.debug({ costSoFar }, '[SandboxExecutor] Cost cap reached');
      break;
    }

    const result = await provider.createMessage({
      system: sandboxSystemPrompt,
      messages,
      maxTokens: 1000,
      temperature: 0.3,
    });

    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;

    const content = result.content;

    if (!content.includes('tool_use') && !content.includes('I would use') && iteration > 0) {
      finalOutput = content;
      break;
    }

    const toolMentions = content.match(/(?:use|call|invoke|execute)\s+(?:the\s+)?(\w+)/gi);
    if (toolMentions) {
      toolCallCount += toolMentions.length;
    }

    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: SANDBOX_TOOL_RESPONSE });

    finalOutput = content;
  }

  const costCents = calculateCostCents(totalInputTokens, totalOutputTokens);

  return {
    scenario,
    completed: finalOutput.length > 0,
    output: finalOutput.slice(0, 2000),
    verificationScore: 0,
    toolCallCount,
    learningsExtracted: 0,
    costCents,
  };
}
