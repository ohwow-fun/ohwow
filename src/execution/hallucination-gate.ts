/**
 * Fail-closed gate for agent task completion.
 *
 * An agent task that produces text-only output to a work-shaped
 * prompt is almost always fabricated — the model composed a
 * plausible response instead of actually running tools. Without
 * this gate, finalizeTaskSuccess happily marks the task 'completed'
 * and the hallucinated output becomes the task's recorded result.
 *
 * Strict by default. Agents that legitimately answer without tools
 * (chat, reasoning, Q&A) opt out via
 * `agentConfig.allow_text_only_tasks: true`.
 *
 * Invoked from RuntimeEngine.executeTask between the ReAct loop
 * return and finalizeTaskSuccess. Throws HallucinationDetectedError
 * on failure; the outer catch in executeTask routes through
 * handleTaskFailure which writes status='failed' + error_message.
 *
 * Surfaced by proprioception experiment #2: ohwow-self (tools:
 * web_research only) was scheduled to run SQL queries + write a
 * diary file, called zero tools, fabricated every number, claimed
 * "FILE WRITTEN: 2,100 bytes", and the task was marked completed.
 */

import type { ReActStep } from './task-completion.js';

export class HallucinationDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HallucinationDetectedError';
  }
}

/**
 * True when a task input is long enough and contains action verbs
 * that strongly imply tool use. Short inputs and pure-reasoning
 * prompts fall through.
 */
export function looksLikeToolWork(input: string): boolean {
  if (input.length < 400) return false;
  return /\b(run|query|write|create|save|mkdir|sqlite|bash|SELECT|INSERT|UPDATE|DELETE|file|append|execute|fetch|POST|GET|curl|install|build|commit|push|migrate)\b/i.test(input);
}

/**
 * Count tool calls across every ReAct iteration.
 */
function countToolCalls(reactTrace: ReActStep[]): number {
  return reactTrace.reduce((sum, step) => sum + step.actions.length, 0);
}

/**
 * Throw HallucinationDetectedError when a task completed without
 * calling any tools but its input requires tool use. Opt-out via
 * agentConfig.allow_text_only_tasks === true.
 */
export function assertTaskWasGrounded(args: {
  reactTrace: ReActStep[];
  taskInput: string;
  agentConfig: Record<string, unknown>;
}): void {
  if (args.agentConfig.allow_text_only_tasks === true) return;
  if (countToolCalls(args.reactTrace) > 0) return;
  if (!looksLikeToolWork(args.taskInput)) return;
  throw new HallucinationDetectedError(
    `Agent produced text-only output (0 tool calls) to a ${args.taskInput.length}-char task that requires tool use. Likely hallucinated. Check agent tools_enabled vs task requirements, or set allow_text_only_tasks: true on the agent config if this task shape is legitimate chat.`,
  );
}
