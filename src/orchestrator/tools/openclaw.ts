/**
 * OpenClaw Tools
 * Orchestrator tools for managing the OpenClaw integration.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ToolHandler } from '../local-tool-types.js';
import { loadConfig } from '../../config.js';

/**
 * Schemas for the four OpenClaw skill-management tools. Previously the
 * handlers were registered in tools/registry.ts but no schema surfaced
 * them, so the orchestrator model could never see or call them — dead
 * handler code. Found during the S3.12 bug-bounty audit and held over
 * until now because S3.12 only fixed update_agent_status.
 */
export const OPENCLAW_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'openclaw_list_skills',
    description:
      'List every skill discoverable through the local OpenClaw binary, marking which are already allowlisted for this workspace. Use before importing a new skill to see what is available, or as a safety check on the current allowlist.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'openclaw_import_skill',
    description:
      'Import and allowlist an OpenClaw skill by id. Runs the security audit first — rejects skills that fail audit. Persists the updated allowlist to ~/.ohwow/config.json so the skill is available across restarts. Always confirm with the user before calling.',
    input_schema: {
      type: 'object' as const,
      properties: {
        skill_id: { type: 'string', description: 'The OpenClaw skill id to import' },
      },
      required: ['skill_id'],
    },
  },
  {
    name: 'openclaw_remove_skill',
    description:
      'Remove a skill from the OpenClaw allowlist. The binary itself is untouched — only the allowlist entry is dropped, so the orchestrator will refuse to dispatch the skill on the next call. Always confirm with the user before calling.',
    input_schema: {
      type: 'object' as const,
      properties: {
        skill_id: { type: 'string', description: 'The OpenClaw skill id to remove from the allowlist' },
      },
      required: ['skill_id'],
    },
  },
  {
    name: 'openclaw_audit_skill',
    description:
      'Run the OpenClaw security audit against a skill without importing it. Returns the audit verdict plus any findings — useful for reviewing a skill before allowlisting or debugging why a previous import failed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        skill_id: { type: 'string', description: 'The OpenClaw skill id to audit' },
      },
      required: ['skill_id'],
    },
  },
];

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
