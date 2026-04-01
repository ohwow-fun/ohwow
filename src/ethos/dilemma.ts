import type { FrameworkResult } from './types.js';

export interface DilemmaResult {
  detected: boolean;
  description: string | null;
}

/**
 * Detect ethical dilemmas: situations where frameworks fundamentally disagree.
 * A dilemma exists when at least one framework approves AND at least one denies.
 */
export function detectDilemma(results: FrameworkResult[]): DilemmaResult {
  const approvals = results.filter(r => r.verdict === 'approve');
  const denials = results.filter(r => r.verdict === 'deny');

  if (approvals.length > 0 && denials.length > 0) {
    const approvalFrameworks = approvals.map(r => r.framework).join(', ');
    const denialFrameworks = denials.map(r => r.framework).join(', ');

    return {
      detected: true,
      description: `Ethical dilemma: ${approvalFrameworks} approve while ${denialFrameworks} deny. ` +
        `Approval reasoning: ${approvals[0].reasoning}. ` +
        `Denial reasoning: ${denials[0].reasoning}.`,
    };
  }

  return { detected: false, description: null };
}
