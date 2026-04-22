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

export interface TrusteeContact {
  /** Email address to notify on mode transitions. */
  emailAddress: string;
  /** Optional webhook URL to POST on mode transitions. */
  webhookUrl?: string;
}

export interface EternalSpec {
  /** Path to an on-disk values corpus file (alternative to inline). */
  valuesCorpusPath?: string;
  /** Inline values corpus text (takes precedence over valuesCorpusPath). */
  valuesCorpusInline?: string;
  inactivityProtocol: InactivityProtocol;
  escalationMap: EscalationRule[];
  /** Trustee contact for mode transition delivery. Configurable via eternal.config.json. */
  trustee?: TrusteeContact;
  /**
   * SLA thresholds in days by contact_type. When a contact has had no
   * activity for longer than its threshold, the SLA watcher writes a
   * founder_inbox alert. Omitting a type means that type is not monitored.
   */
  contactSlaDays?: Record<string, number>;
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
