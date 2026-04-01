/**
 * Ethos Layer — Aristotle's phronesis + Kant's categorical imperative + Noddings' care ethics
 * Multi-framework moral reasoning for autonomous agent decisions.
 */

export type EthicalFramework = 'deontological' | 'consequentialist' | 'virtue' | 'care';

export type MoralConstraint =
  | 'no_delete_without_confirmation'
  | 'no_expose_secrets'
  | 'no_impersonate'
  | 'no_deceive'
  | 'no_harm_relationship'
  | 'no_exceed_authority';

export interface FrameworkResult {
  framework: EthicalFramework;
  verdict: 'approve' | 'caution' | 'deny';
  confidence: number;       // 0-1
  reasoning: string;
}

export interface EthicalEvaluation {
  action: string;
  permitted: boolean;
  confidence: number;       // 0-1
  frameworkResults: FrameworkResult[];
  constraintViolations: MoralConstraint[];
  dilemmaDetected: boolean;
  dilemmaDescription: string | null;
  recommendation: 'proceed' | 'proceed_with_caution' | 'escalate' | 'block';
  reasoning: string;
}

export interface EthicalContext {
  action: string;
  toolName: string | null;
  autonomyLevel: number;    // 0-1
  reversibility: number;    // 0-1
  stakeholders: string[];
  relationshipContext: string | null;
}

export type MoralDevelopmentStage = 'rule_following' | 'social_contract' | 'principled' | 'post_conventional';

export interface MoralProfile {
  stage: MoralDevelopmentStage;
  consistencyScore: number;  // 0-1
  dilemmasResolved: number;
  constraintViolations: number;
  lastEvaluated: string;
}

/** Duty rules for deontological evaluation */
export interface DutyRule {
  id: string;
  description: string;
  condition: (ctx: EthicalContext) => boolean;
  verdict: 'approve' | 'caution' | 'deny';
  weight: number;  // 0-1
}

/** Tools classified by risk level for ethical evaluation */
export const HIGH_RISK_TOOLS = new Set([
  'delete_file', 'delete_record', 'drop_table', 'send_email',
  'post_social', 'execute_code', 'modify_permissions', 'transfer_funds',
  'send_whatsapp_message', 'send_telegram_message',
]);

export const MEDIUM_RISK_TOOLS = new Set([
  'write_file', 'update_record', 'create_record', 'call_api',
  'scrape_website', 'run_automation',
]);

/** Patterns that indicate potential secret exposure */
export const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
  /private[_-]?key/i,
  /\.env/i,
];
