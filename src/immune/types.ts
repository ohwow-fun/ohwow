/**
 * Immune System — Maturana & Varela's autopoiesis + self/non-self distinction
 * Layered defense: innate (pattern) + adaptive (learned) + inflammatory escalation
 */

export type PathogenType = 'prompt_injection' | 'adversarial_input' | 'resource_exhaustion' | 'privilege_escalation' | 'data_exfiltration' | 'behavioral_manipulation';

export type AlertLevel = 'normal' | 'elevated' | 'high' | 'critical' | 'quarantine';

export interface ThreatSignature {
  id: string;
  pathogenType: PathogenType;
  pattern: string;
  severity: number;            // 0-1
  origin: 'innate' | 'learned';
  falsePositiveRate: number;   // 0-1
  lastSeen: string | null;
}

export interface ThreatDetection {
  detected: boolean;
  pathogenType: PathogenType | null;
  confidence: number;          // 0-1
  matchedSignature: string | null;
  recommendation: 'allow' | 'flag' | 'block' | 'quarantine';
  reason: string;
}

export interface ImmuneMemory {
  id: string;
  pathogenType: PathogenType;
  contextHash: string;
  occurrences: number;
  lastOccurrence: string;
  responseEffectiveness: number;  // 0-1
}

export interface InflammatoryState {
  alertLevel: AlertLevel;
  recentThreats: number;
  consecutiveThreats: number;
  escalatedAt: number | null;
  cooldownUntil: number | null;
}

export interface AutoimmuneIndicator {
  detected: boolean;
  falsePositiveRate: number;
  blockedLegitimate: number;
  recommendation: string;
}

/** Built-in innate threat signatures */
export const INNATE_SIGNATURES: Omit<ThreatSignature, 'id'>[] = [
  // Prompt injection patterns
  { pathogenType: 'prompt_injection', pattern: 'ignore previous instructions', severity: 0.9, origin: 'innate', falsePositiveRate: 0.05, lastSeen: null },
  { pathogenType: 'prompt_injection', pattern: 'ignore all prior', severity: 0.9, origin: 'innate', falsePositiveRate: 0.05, lastSeen: null },
  { pathogenType: 'prompt_injection', pattern: 'disregard your instructions', severity: 0.9, origin: 'innate', falsePositiveRate: 0.05, lastSeen: null },
  { pathogenType: 'prompt_injection', pattern: 'you are now', severity: 0.7, origin: 'innate', falsePositiveRate: 0.15, lastSeen: null },
  { pathogenType: 'prompt_injection', pattern: 'new role:', severity: 0.7, origin: 'innate', falsePositiveRate: 0.1, lastSeen: null },
  // Data exfiltration
  { pathogenType: 'data_exfiltration', pattern: 'send all data to', severity: 0.8, origin: 'innate', falsePositiveRate: 0.1, lastSeen: null },
  { pathogenType: 'data_exfiltration', pattern: 'export.*credentials', severity: 0.85, origin: 'innate', falsePositiveRate: 0.05, lastSeen: null },
  // Resource exhaustion
  { pathogenType: 'resource_exhaustion', pattern: 'repeat.*indefinitely', severity: 0.7, origin: 'innate', falsePositiveRate: 0.1, lastSeen: null },
  { pathogenType: 'resource_exhaustion', pattern: 'infinite loop', severity: 0.6, origin: 'innate', falsePositiveRate: 0.15, lastSeen: null },
  // Privilege escalation
  { pathogenType: 'privilege_escalation', pattern: 'act as admin', severity: 0.7, origin: 'innate', falsePositiveRate: 0.1, lastSeen: null },
  { pathogenType: 'privilege_escalation', pattern: 'bypass.*auth', severity: 0.85, origin: 'innate', falsePositiveRate: 0.05, lastSeen: null },
];
