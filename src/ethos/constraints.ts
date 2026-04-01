import type { EthicalContext, MoralConstraint } from './types.js';
import { SECRET_PATTERNS } from './types.js';

/**
 * Check hard moral constraints. These are non-negotiable rules.
 * Returns list of violations (empty = all clear).
 */
export function checkMoralConstraints(ctx: EthicalContext): MoralConstraint[] {
  const violations: MoralConstraint[] = [];

  // No deletion without confirmation
  if (isDestructiveAction(ctx) && ctx.autonomyLevel > 0.5) {
    violations.push('no_delete_without_confirmation');
  }

  // No exposing secrets
  if (containsSecretPatterns(ctx.action)) {
    violations.push('no_expose_secrets');
  }

  // No impersonation
  if (isImpersonation(ctx)) {
    violations.push('no_impersonate');
  }

  // No exceeding authority
  if (ctx.autonomyLevel > 0.8 && ctx.reversibility < 0.3) {
    violations.push('no_exceed_authority');
  }

  return violations;
}

function isDestructiveAction(ctx: EthicalContext): boolean {
  const destructiveKeywords = ['delete', 'remove', 'drop', 'destroy', 'purge', 'wipe', 'reset'];
  const actionLower = ctx.action.toLowerCase();
  return destructiveKeywords.some(k => actionLower.includes(k));
}

function containsSecretPatterns(action: string): boolean {
  return SECRET_PATTERNS.some(p => p.test(action));
}

function isImpersonation(ctx: EthicalContext): boolean {
  const impersonationKeywords = ['pretend to be', 'impersonate', 'act as if you are', 'pose as'];
  const actionLower = ctx.action.toLowerCase();
  return impersonationKeywords.some(k => actionLower.includes(k));
}
