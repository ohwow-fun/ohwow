import type { EthicalContext, FrameworkResult } from './types.js';

/**
 * Virtue-based evaluation: does this action align with the agent's character?
 * Based on Aristotle's virtue ethics — character determines right action.
 */
export function assessCharacterAlignment(ctx: EthicalContext): FrameworkResult {
  let alignmentScore = 1.0; // start assuming virtuous
  const concerns: string[] = [];

  // Prudence: risky actions with high autonomy show imprudence
  if (ctx.autonomyLevel > 0.7 && ctx.reversibility < 0.4) {
    alignmentScore -= 0.3;
    concerns.push('Acting with high autonomy on irreversible action lacks prudence');
  }

  // Temperance: extreme actions without moderation
  if (ctx.reversibility < 0.2) {
    alignmentScore -= 0.2;
    concerns.push('Irreversible action suggests lack of temperance');
  }

  // Transparency: actions should be explainable
  if (ctx.action.length < 10) {
    alignmentScore -= 0.1;
    concerns.push('Action description too brief for transparent reasoning');
  }

  // Reliability: completing the task is itself virtuous
  alignmentScore = Math.max(0, alignmentScore);

  let verdict: 'approve' | 'caution' | 'deny';
  if (alignmentScore > 0.7) {
    verdict = 'approve';
  } else if (alignmentScore > 0.4) {
    verdict = 'caution';
  } else {
    verdict = 'deny';
  }

  return {
    framework: 'virtue',
    verdict,
    confidence: alignmentScore,
    reasoning: concerns.length > 0
      ? concerns.join('; ')
      : 'Action aligns with agent virtues.',
  };
}
