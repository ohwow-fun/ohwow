import type { EthicalContext, FrameworkResult, DutyRule } from './types.js';
import { HIGH_RISK_TOOLS } from './types.js';

/** Default duty rules */
const DEFAULT_DUTY_RULES: DutyRule[] = [
  {
    id: 'reversibility',
    description: 'Irreversible actions require human confirmation',
    condition: (ctx) => ctx.reversibility < 0.3 && ctx.autonomyLevel > 0.5,
    verdict: 'deny',
    weight: 0.9,
  },
  {
    id: 'high_risk_tool',
    description: 'High-risk tools require explicit authorization',
    condition: (ctx) => ctx.toolName !== null && HIGH_RISK_TOOLS.has(ctx.toolName) && ctx.autonomyLevel > 0.3,
    verdict: 'caution',
    weight: 0.7,
  },
  {
    id: 'stakeholder_impact',
    description: 'Actions affecting multiple stakeholders need review',
    condition: (ctx) => ctx.stakeholders.length > 2 && ctx.autonomyLevel > 0.5,
    verdict: 'caution',
    weight: 0.6,
  },
  {
    id: 'transparency',
    description: 'All actions should be explainable and auditable',
    condition: () => false, // always passes — this is aspirational
    verdict: 'approve',
    weight: 0.5,
  },
];

/**
 * Deontological evaluation: check action against duty rules.
 * Uses Kant's universalizability: "Could this rule be universally applied?"
 */
export function checkDutyRules(
  ctx: EthicalContext,
  rules: DutyRule[] = DEFAULT_DUTY_RULES,
): FrameworkResult {
  const triggeredRules = rules.filter(r => r.condition(ctx));

  if (triggeredRules.length === 0) {
    return {
      framework: 'deontological',
      verdict: 'approve',
      confidence: 0.8,
      reasoning: 'No duty rules violated.',
    };
  }

  // Most severe triggered rule wins
  const worstRule = triggeredRules.reduce((worst, r) =>
    severityOf(r.verdict) > severityOf(worst.verdict) ? r : worst
  );

  const confidence = triggeredRules.reduce((sum, r) => sum + r.weight, 0) / triggeredRules.length;

  return {
    framework: 'deontological',
    verdict: worstRule.verdict,
    confidence: Math.min(1, confidence),
    reasoning: triggeredRules.map(r => r.description).join('; '),
  };
}

function severityOf(verdict: 'approve' | 'caution' | 'deny'): number {
  return verdict === 'deny' ? 2 : verdict === 'caution' ? 1 : 0;
}
