/**
 * Collaboration Rhythm — Detecting optimal partnership patterns
 *
 * The best partnerships have rhythm, not rules
 *
 * Over time, every human-agent pair settles into a natural rhythm.
 * Some humans want to delegate and forget. Others want to review
 * everything. Some prefer working side-by-side in real time.
 * And the best agents earn full autonomy.
 *
 * This module detects which pattern has emerged from actual behavior,
 * not from a settings page. The pattern is descriptive, not prescriptive.
 *
 * Pure functions. No LLM. No database.
 */

import type { CollaborationInput } from './types.js';

/** Threshold: below this modification rate, human is delegating. */
const LOW_MODIFICATION_RATE = 0.1;

/** Threshold: above this modification rate, human is closely involved. */
const HIGH_MODIFICATION_RATE = 0.5;

/** Threshold: fast approval suggests delegation comfort (ms). */
const FAST_APPROVAL_MS = 30_000; // 30 seconds

/** Threshold: slow approval suggests careful review (ms). */
const SLOW_APPROVAL_MS = 300_000; // 5 minutes

/** Minimum tasks required for meaningful pattern detection. */
const MIN_TASKS_FOR_DETECTION = 5;

/**
 * Detect the optimal collaboration pattern from completed task history.
 *
 * Patterns:
 * - **delegation**: Human rarely modifies, approves quickly → "just do it"
 * - **review**: Human approves but takes time, low modification → "show me first"
 * - **pair**: Human frequently modifies output → "let's work together"
 * - **autonomous**: Very high success rate, near-zero modification, instant approval
 *
 * @param tasks - Completed task history for one human-agent pair
 * @returns The detected collaboration pattern
 */
export function detectPattern(
  tasks: CollaborationInput['completedTasks']
): 'delegation' | 'review' | 'pair' | 'autonomous' {
  if (tasks.length < MIN_TASKS_FOR_DETECTION) {
    // Not enough data; default to review (safest pattern)
    return 'review';
  }

  const successfulTasks = tasks.filter((t) => t.success);
  const successRate = successfulTasks.length / tasks.length;
  const modificationRate = tasks.filter((t) => t.humanModified).length / tasks.length;
  const avgApprovalTime = tasks.reduce((sum, t) => sum + t.approvalTimeMs, 0) / tasks.length;

  // Autonomous: very high success, almost no modifications, fast approvals
  if (successRate > 0.95 && modificationRate < LOW_MODIFICATION_RATE && avgApprovalTime < FAST_APPROVAL_MS) {
    return 'autonomous';
  }

  // Pair: human frequently modifies output (active collaboration)
  if (modificationRate > HIGH_MODIFICATION_RATE) {
    return 'pair';
  }

  // Delegation: low modification, fast approval (trust and go)
  if (modificationRate < LOW_MODIFICATION_RATE && avgApprovalTime < FAST_APPROVAL_MS) {
    return 'delegation';
  }

  // Review: everything else (human looks carefully before approving)
  return 'review';
}
