/**
 * Wu Wei: the wisdom of rest. Recovery is productive.
 */

import type { RecoveryInput } from './types.js';

const HIGH_INTENSITY_THRESHOLD = 5;

const HIGH_INTENSITY_KEYWORDS = ['high', 'intense', 'sprint', 'crunch', 'overtime'];

/**
 * Assess whether the user needs recovery after sustained high-intensity work.
 *
 * If 5+ consecutive high intensity days, recommend shifting to reflective
 * (theoria) work. The body and mind need oscillation, not relentless output.
 */
export function assessRecovery(
  input: RecoveryInput
): { needed: boolean; recommendation: string } {
  const isCurrentlyHigh = HIGH_INTENSITY_KEYWORDS.some((kw) =>
    input.currentWorkIntensity.toLowerCase().includes(kw)
  );

  if (input.consecutiveHighIntensityDays >= HIGH_INTENSITY_THRESHOLD) {
    return {
      needed: true,
      recommendation: isCurrentlyHigh
        ? 'You have been in high intensity mode for ' +
          input.consecutiveHighIntensityDays +
          ' days. Consider shifting to reflective work: reviewing strategy, journaling, or planning. Recovery is productive.'
        : 'After ' +
          input.consecutiveHighIntensityDays +
          ' high intensity days, ease into today. Light reviews, documentation, or creative exploration. Let the mind rest.',
    };
  }

  if (input.consecutiveHighIntensityDays >= 3 && isCurrentlyHigh) {
    return {
      needed: false,
      recommendation:
        'Three intense days in a row. You can keep going, but plan a lighter day soon. Sustained peaks need valleys.',
    };
  }

  return {
    needed: false,
    recommendation: 'Energy balance looks healthy. Carry on.',
  };
}
