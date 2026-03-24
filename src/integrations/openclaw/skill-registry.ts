/**
 * OpenClaw Skill Registry
 * Manages the allowlisted skills: list available, import, and remove.
 */

import { execFileSync } from 'child_process';
import { logger } from '../../lib/logger.js';
import type { OpenClawSkillManifest } from './types.js';
import { auditSkill } from './security.js';

/**
 * List all skills available in the local OpenClaw installation.
 */
export function listAvailableSkills(binaryPath: string): OpenClawSkillManifest[] {
  try {
    const output = execFileSync(binaryPath, ['skill', 'list', '--json'], {
      encoding: 'utf-8',
      timeout: 15_000,
    });
    const skills = JSON.parse(output);
    if (!Array.isArray(skills)) return [];

    return skills.map((s: Record<string, unknown>) => ({
      id: String(s.id ?? ''),
      name: String(s.name ?? s.id ?? ''),
      description: String(s.description ?? ''),
      version: String(s.version ?? '0.0.0'),
      author: String(s.author ?? 'unknown'),
      inputSchema: (s.inputSchema as Record<string, unknown>) ?? {},
      outputFormat: String(s.outputFormat ?? 'text'),
      permissions: Array.isArray(s.permissions) ? s.permissions.map(String) : [],
      sourceUrl: s.sourceUrl ? String(s.sourceUrl) : undefined,
      checksum: s.checksum ? String(s.checksum) : undefined,
    }));
  } catch (err) {
    logger.error({ err }, '[OpenClaw] Could not list available skills');
    return [];
  }
}

/**
 * Import (allowlist) a skill after running a security audit.
 * Returns the audit result. Only imports if the audit passes.
 */
export function importSkill(
  binaryPath: string,
  skillId: string,
  currentAllowlist: string[],
): { added: boolean; auditResult: ReturnType<typeof auditSkill>; updatedAllowlist: string[] } {
  // Get manifest
  const allSkills = listAvailableSkills(binaryPath);
  const manifest = allSkills.find(s => s.id === skillId);

  if (!manifest) {
    return {
      added: false,
      auditResult: {
        skillId,
        passed: false,
        findings: [{ severity: 'critical', category: 'not_found', message: `Skill "${skillId}" not found in OpenClaw` }],
        scannedAt: new Date().toISOString(),
        hasDangerousPatterns: false,
      },
      updatedAllowlist: currentAllowlist,
    };
  }

  // Already allowlisted
  if (currentAllowlist.includes(skillId)) {
    const auditResult = auditSkill(manifest);
    return { added: false, auditResult, updatedAllowlist: currentAllowlist };
  }

  // Audit
  const auditResult = auditSkill(manifest);
  if (!auditResult.passed) {
    logger.warn({ skillId, findings: auditResult.findings.length }, '[OpenClaw] Skill failed audit, not importing');
    return { added: false, auditResult, updatedAllowlist: currentAllowlist };
  }

  // Add to allowlist
  const updatedAllowlist = [...currentAllowlist, skillId];
  logger.info({ skillId }, '[OpenClaw] Skill imported to allowlist');

  return { added: true, auditResult, updatedAllowlist };
}

/**
 * Remove a skill from the allowlist.
 */
export function removeSkill(
  skillId: string,
  currentAllowlist: string[],
): { removed: boolean; updatedAllowlist: string[] } {
  if (!currentAllowlist.includes(skillId)) {
    return { removed: false, updatedAllowlist: currentAllowlist };
  }

  const updatedAllowlist = currentAllowlist.filter(id => id !== skillId);
  logger.info({ skillId }, '[OpenClaw] Skill removed from allowlist');

  return { removed: true, updatedAllowlist };
}
