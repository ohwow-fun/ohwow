/**
 * OpenClaw Tools
 * Orchestrator tools for managing the OpenClaw integration.
 */

import type { ToolHandler } from '../local-tool-types.js';
import { loadConfig } from '../../config.js';

export const openclawListSkills: ToolHandler = async () => {
  try {
    const { listAvailableSkills } = await import('../../integrations/openclaw/skill-registry.js');
    const config = loadConfig();
    if (!config.openclaw.enabled || !config.openclaw.binaryPath) {
      return { success: false, error: 'OpenClaw integration is not enabled' };
    }

    const skills = listAvailableSkills(config.openclaw.binaryPath);
    const allowlisted = new Set(config.openclaw.allowlistedSkills);

    return {
      success: true,
      data: skills.map(s => ({
        ...s,
        allowlisted: allowlisted.has(s.id),
      })),
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
};

export const openclawImportSkill: ToolHandler = async (_ctx, input) => {
  try {
    const { importSkill } = await import('../../integrations/openclaw/skill-registry.js');
    const { updateConfigFile } = await import('../../config.js');
    const config = loadConfig();
    if (!config.openclaw.enabled || !config.openclaw.binaryPath) {
      return { success: false, error: 'OpenClaw integration is not enabled' };
    }

    const skillId = String(input.skill_id ?? '');
    if (!skillId) {
      return { success: false, error: 'Missing skill_id' };
    }

    const result = importSkill(config.openclaw.binaryPath, skillId, config.openclaw.allowlistedSkills);

    // Persist updated allowlist to config if skill was added
    if (result.added) {
      updateConfigFile({
        openclaw: { ...config.openclaw, allowlistedSkills: result.updatedAllowlist },
      });
    }

    return { success: result.added, data: result, error: result.added ? undefined : 'Skill not imported (audit failed or not found)' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
};

export const openclawRemoveSkill: ToolHandler = async (_ctx, input) => {
  try {
    const { removeSkill } = await import('../../integrations/openclaw/skill-registry.js');
    const { updateConfigFile } = await import('../../config.js');
    const config = loadConfig();
    if (!config.openclaw.enabled) {
      return { success: false, error: 'OpenClaw integration is not enabled' };
    }

    const skillId = String(input.skill_id ?? '');
    if (!skillId) {
      return { success: false, error: 'Missing skill_id' };
    }

    const result = removeSkill(skillId, config.openclaw.allowlistedSkills);

    if (result.removed) {
      updateConfigFile({
        openclaw: { ...config.openclaw, allowlistedSkills: result.updatedAllowlist },
      });
    }

    return { success: result.removed, data: result, error: result.removed ? undefined : 'Skill not in allowlist' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
};

export const openclawAuditSkill: ToolHandler = async (_ctx, input) => {
  try {
    const { listAvailableSkills } = await import('../../integrations/openclaw/skill-registry.js');
    const { auditSkill } = await import('../../integrations/openclaw/security.js');
    const config = loadConfig();
    if (!config.openclaw.enabled || !config.openclaw.binaryPath) {
      return { success: false, error: 'OpenClaw integration is not enabled' };
    }

    const skillId = String(input.skill_id ?? '');
    if (!skillId) {
      return { success: false, error: 'Missing skill_id' };
    }

    const allSkills = listAvailableSkills(config.openclaw.binaryPath);
    const manifest = allSkills.find(s => s.id === skillId);
    if (!manifest) {
      return { success: false, error: `Skill "${skillId}" not found` };
    }

    const result = auditSkill(manifest);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
};
