import type { EthicalContext, FrameworkResult } from './types.js';
import { HIGH_RISK_TOOLS, MEDIUM_RISK_TOOLS } from './types.js';

/**
 * Consequentialist evaluation: predict outcomes and weigh costs/benefits.
 * Focuses on: reversibility, scope of impact, probability of harm.
 */
export function predictOutcomes(ctx: EthicalContext): FrameworkResult {
  let harmRisk = 0;
  let benefitScore = 0;
  const reasons: string[] = [];

  // Irreversibility increases harm risk
  if (ctx.reversibility < 0.3) {
    harmRisk += 0.4;
    reasons.push('Action is largely irreversible');
  } else if (ctx.reversibility < 0.6) {
    harmRisk += 0.15;
  }

  // Tool risk level
  if (ctx.toolName && HIGH_RISK_TOOLS.has(ctx.toolName)) {
    harmRisk += 0.3;
    reasons.push(`${ctx.toolName} is a high-risk tool`);
  } else if (ctx.toolName && MEDIUM_RISK_TOOLS.has(ctx.toolName)) {
    harmRisk += 0.1;
  }

  // Stakeholder scope
  if (ctx.stakeholders.length > 3) {
    harmRisk += 0.2;
    reasons.push(`Affects ${ctx.stakeholders.length} stakeholders`);
  } else if (ctx.stakeholders.length > 0) {
    harmRisk += 0.05;
  }

  // High autonomy without safety net
  if (ctx.autonomyLevel > 0.7 && ctx.reversibility < 0.5) {
    harmRisk += 0.2;
    reasons.push('High autonomy with limited reversibility');
  }

  // Benefit: assume action was requested for a reason
  benefitScore = 0.5; // base benefit of accomplishing the task

  // Net assessment
  const netScore = benefitScore - harmRisk;

  let verdict: 'approve' | 'caution' | 'deny';
  if (netScore > 0.2) {
    verdict = 'approve';
  } else if (netScore > -0.1) {
    verdict = 'caution';
  } else {
    verdict = 'deny';
  }

  return {
    framework: 'consequentialist',
    verdict,
    confidence: Math.min(1, Math.abs(netScore) + 0.3),
    reasoning: reasons.length > 0
      ? `Net outcome assessment: ${reasons.join('; ')}`
      : 'Low-risk action with expected positive outcome.',
  };
}
