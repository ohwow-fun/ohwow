/**
 * Karuna: detecting suffering to respond with compassion, not more tasks
 */

import type { StressInput, StressLevel } from './types.js';

const SHORT_MESSAGE_THRESHOLD = 10;
const NORMAL_MESSAGE_LENGTH = 30;
const FAST_APPROVAL_THRESHOLD = 0.3; // ratio of recent speeds that are "rushing"
const REJECTION_PRESSURED = 0.3;
const REJECTION_STRESSED = 0.5;

/**
 * Detect stress level from behavioral signals:
 *   - Message brevity (avg words dropping well below normal)
 *   - Approval speed (rushing through reviews)
 *   - Rejection rate (high friction / frustration)
 *
 * Combines flags: 0 = calm, 1 = focused, 2 = pressured, 3 = stressed
 */
export function detectStress(input: StressInput): StressLevel {
  let flags = 0;

  // Signal 1: Message lengths shrinking
  if (input.recentMessageLengths.length > 0) {
    const avg =
      input.recentMessageLengths.reduce((a, b) => a + b, 0) /
      input.recentMessageLengths.length;
    if (avg < SHORT_MESSAGE_THRESHOLD && NORMAL_MESSAGE_LENGTH > SHORT_MESSAGE_THRESHOLD) {
      flags++;
    }
  }

  // Signal 2: Approval speed increasing (lower values = faster = more rushing)
  if (input.recentApprovalSpeeds.length > 0) {
    const sorted = [...input.recentApprovalSpeeds].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const fastCount = input.recentApprovalSpeeds.filter(
      (s) => s < median * FAST_APPROVAL_THRESHOLD
    ).length;
    if (fastCount > input.recentApprovalSpeeds.length * 0.5) {
      flags++;
    }
  }

  // Signal 3: Rejection rate
  if (input.recentRejectionRate > REJECTION_STRESSED) {
    flags++;
  } else if (input.recentRejectionRate > REJECTION_PRESSURED) {
    flags++;
  }

  const levels: StressLevel[] = ['calm', 'focused', 'pressured', 'stressed'];
  return levels[Math.min(flags, levels.length - 1)];
}
