/**
 * OpenClaw Integration Types
 * Configuration, skill manifests, audit results, and call logs
 * for the OpenClaw agent ecosystem integration.
 */

// ============================================================================
// CONFIG
// ============================================================================

export interface OpenClawConfig {
  /** Whether OpenClaw integration is enabled */
  enabled: boolean;
  /** Path to the OpenClaw CLI binary (auto-detected if empty) */
  binaryPath: string;
  /** Allowlisted skill IDs (only these can be called) */
  allowlistedSkills: string[];
  /** Rate limit: max calls per minute per skill */
  rateLimitPerMinute: number;
  /** Rate limit: max calls per hour per skill */
  rateLimitPerHour: number;
  /** Whether to allow network access in sandbox (default: false) */
  sandboxAllowNetwork: boolean;
  /** Max execution time per skill call in ms */
  maxExecutionTimeMs: number;
}

export const DEFAULT_OPENCLAW_CONFIG: OpenClawConfig = {
  enabled: false,
  binaryPath: '',
  allowlistedSkills: [],
  rateLimitPerMinute: 10,
  rateLimitPerHour: 100,
  sandboxAllowNetwork: false,
  maxExecutionTimeMs: 30_000,
};

// ============================================================================
// SKILL MANIFEST
// ============================================================================

export interface OpenClawSkillManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  /** Input parameter schema (JSON Schema) */
  inputSchema: Record<string, unknown>;
  /** Output format description */
  outputFormat: string;
  /** Required permissions (filesystem, network, env) */
  permissions: string[];
  /** Source repository URL */
  sourceUrl?: string;
  /** SHA256 hash of the skill package */
  checksum?: string;
}

// ============================================================================
// AUDIT
// ============================================================================

export type AuditSeverity = 'info' | 'warning' | 'critical';

export interface AuditFinding {
  severity: AuditSeverity;
  category: string;
  message: string;
  line?: number;
  file?: string;
}

export interface OpenClawAuditResult {
  skillId: string;
  passed: boolean;
  findings: AuditFinding[];
  scannedAt: string;
  /** Whether the skill uses any dangerous patterns */
  hasDangerousPatterns: boolean;
}

// ============================================================================
// CALL LOG
// ============================================================================

export interface OpenClawCallLog {
  id?: number;
  timestamp: string;
  skillId: string;
  agentId: string;
  input: string;
  output: string;
  durationMs: number;
  success: boolean;
  error?: string;
}
