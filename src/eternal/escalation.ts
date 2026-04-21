/**
 * Eternal Systems — escalation policy.
 *
 * Pure function that answers: given a decision type and optional spend
 * amount, does the current EscalationRule set require trustee approval?
 *
 * Rules are evaluated in order. The first rule whose decisionType matches
 * (case-insensitive) wins. If no rule matches, the default is to NOT
 * require trustee approval (permissive fallback keeps the system moving
 * when operators haven't configured a rule for an uncommon decision type).
 */
import type { EscalationRule } from './types.js';

/**
 * Map a conductor phase mode to the decision type used for escalation
 * lookups. Revenue work is classified as expense_small; everything else
 * is outreach-grade (operational, no spend involved).
 */
const MODE_TO_DECISION_TYPE: Record<string, string> = {
  revenue: 'expense_small',
  polish: 'outreach',
  plumbing: 'outreach',
  tooling: 'outreach',
};

export function modeToDecisionType(phaseMode: string): string {
  return MODE_TO_DECISION_TYPE[phaseMode] ?? 'outreach';
}

/**
 * Returns true when the escalation rules require trustee approval for
 * the given decision.
 *
 * @param decisionType  Category string, e.g. 'expense_large', 'strategic'.
 * @param amountCents   Optional spend amount in US cents.
 * @param rules         The operator's configured escalation map.
 */
export function requiresTrusteeApproval(
  decisionType: string,
  amountCents: number | undefined,
  rules: EscalationRule[],
): boolean {
  const normalised = decisionType.toLowerCase();
  const rule = rules.find((r) => r.decisionType.toLowerCase() === normalised);

  if (!rule) return false;
  if (!rule.requiresTrustee) return false;

  // If the rule has an automatedBelow threshold and the spend is under it,
  // the rule itself permits automation even though requiresTrustee is set.
  // This handles cases like "require trustee above $500 but auto-approve
  // anything under that".
  if (
    rule.automatedBelow !== undefined &&
    amountCents !== undefined &&
    amountCents < rule.automatedBelow * 100
  ) {
    return false;
  }

  return true;
}
