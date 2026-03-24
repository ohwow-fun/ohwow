/**
 * Stagnation Detection (Local Runtime)
 * Detects when an agent is calling the same tool with identical args in a loop.
 * Ported from cloud: src/lib/agents/agent-runner.ts
 */

import { createHash } from 'crypto';

/**
 * Hash a tool call (name + input) into a compact digest for comparison.
 */
export function hashToolCall(name: string, input: unknown): string {
  return createHash('md5').update(`${name}:${JSON.stringify(input)}`).digest('hex');
}

/**
 * Detect stagnation: returns true if the last `windowSize` hashes are identical.
 */
export function detectStagnation(hashes: string[], windowSize = 3): boolean {
  if (hashes.length < windowSize) return false;
  const last = hashes[hashes.length - 1];
  const window = hashes.slice(-windowSize);
  return window.every((h) => h === last);
}

export const STAGNATION_PROMPT =
  '[SYSTEM NOTICE] You have called the same tool with identical arguments multiple times in a row. ' +
  'This is not making progress. Try a different approach, use different parameters, or conclude your task.';

export const REFLECTION_PROMPT =
  '[SYSTEM NOTICE] You are now at iteration {{N}} of {{MAX}}. ' +
  'Briefly assess: Are you making progress toward the goal? ' +
  'If stuck, change your approach. If done, provide your final answer.';
