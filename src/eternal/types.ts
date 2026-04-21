/**
 * Eternal Systems — type definitions.
 *
 * Implements the 5-layer Eternal Systems framework from docs/eternal-systems.md.
 * Operators configure a values corpus, inactivity protocol, and escalation map.
 * The runtime enforces conservative/estate modes when the operator goes dark.
 */

export interface InactivityProtocol {
  /** Days of silence before shifting to conservative mode. Default 7. */
  conservativeAfterDays: number;
  /** Days of silence before pinging a trustee. Default 7. */
  trusteePingAfterDays: number;
  /** Days of silence before entering estate mode. Default 90. */
  estateAfterDays: number;
}

export type EternalMode = 'normal' | 'conservative' | 'estate';

export interface EscalationRule {
  /** Decision category, e.g. 'outreach', 'expense_small', 'expense_large', 'strategic'. */
  decisionType: string;
  /** Auto-approve spend below this dollar amount (omit to never auto-approve). */
  automatedBelow?: number;
  /** When true, this decision type always requires trustee approval. */
  requiresTrustee: boolean;
}

export interface EternalSpec {
  /** Path to an on-disk values corpus file (alternative to inline). */
  valuesCorpusPath?: string;
  /** Inline values corpus text (takes precedence over valuesCorpusPath). */
  valuesCorpusInline?: string;
  inactivityProtocol: InactivityProtocol;
  escalationMap: EscalationRule[];
}

export interface EternalState {
  mode: EternalMode;
  /** ISO timestamp of the last recorded operator activity, or null if never recorded. */
  lastActivityAt: string | null;
  /** ISO timestamp when the mode last changed, or null. */
  modeChangedAt: string | null;
  /** Human-readable reason for the last mode change, or null. */
  modeChangedReason: string | null;
}
