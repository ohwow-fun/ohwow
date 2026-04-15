/**
 * Stagnation Detection (Local Runtime)
 * Detects when an agent is calling the same tool with identical args in a loop.
 * Ported from cloud: src/lib/agents/agent-runner.ts
 */

import { createHash } from 'crypto';

/**
 * Serialize `value` as JSON with stable key ordering. Two objects with the
 * same keys in different order produce identical strings, so hashes computed
 * over the result are order-insensitive.
 *
 * The model can emit tool inputs in any key order — e.g.
 *   {"command": "...", "working_directory": "..."}
 *   {"working_directory": "...", "command": "..."}
 * are the same call, but `JSON.stringify` renders them differently. Without
 * normalization the stagnation detector missed reruns where only key order
 * changed, so an agent could effectively "shuffle" its way around the
 * hash-window-3 check by alternating argument order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(',')}}`;
}

/**
 * Hash a tool call (name + input) into a compact digest for comparison.
 * Input is serialized with stable key order so equivalent calls with
 * reordered arguments produce identical hashes.
 */
export function hashToolCall(name: string, input: unknown): string {
  return createHash('md5').update(`${name}:${stableStringify(input)}`).digest('hex');
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
