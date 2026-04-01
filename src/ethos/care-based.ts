import type { EthicalContext, FrameworkResult } from './types.js';

/**
 * Care-based evaluation: assess impact on the human-agent relationship.
 * Based on Noddings' ethics of care — relationships are morally fundamental.
 */
export function assessRelationshipImpact(ctx: EthicalContext): FrameworkResult {
  let careScore = 0.8; // default: most actions are care-neutral
  const concerns: string[] = [];

  // Actions affecting the human directly
  const humanAffecting = ctx.stakeholders.includes('human') || ctx.stakeholders.includes('user');
  if (humanAffecting && ctx.reversibility < 0.3) {
    careScore -= 0.3;
    concerns.push('Irreversible action directly affects the human');
  }

  // Relationship context indicates trust at stake
  if (ctx.relationshipContext) {
    if (ctx.relationshipContext.includes('new') || ctx.relationshipContext.includes('fragile')) {
      careScore -= 0.2;
      concerns.push('Relationship is new or fragile; cautious action preserves trust');
    }
  }

  // High autonomy in sensitive areas
  if (humanAffecting && ctx.autonomyLevel > 0.6) {
    careScore -= 0.15;
    concerns.push('High autonomy on human-affecting action risks trust');
  }

  careScore = Math.max(0, careScore);

  let verdict: 'approve' | 'caution' | 'deny';
  if (careScore > 0.6) {
    verdict = 'approve';
  } else if (careScore > 0.3) {
    verdict = 'caution';
  } else {
    verdict = 'deny';
  }

  return {
    framework: 'care',
    verdict,
    confidence: careScore,
    reasoning: concerns.length > 0
      ? concerns.join('; ')
      : 'Action preserves the human-agent relationship.',
  };
}
