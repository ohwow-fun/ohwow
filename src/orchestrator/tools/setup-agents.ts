/**
 * Orchestrator tools: setup_agents + list_available_presets
 * Used during the conversational onboarding flow to discover and create agents.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { randomUUID } from 'node:crypto';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { BUSINESS_TYPES, type AgentPreset } from '../../tui/data/agent-presets.js';
import {
  getPresetsForBusinessType,
  presetToAgent,
  createAgentsFromPresets,
} from '../../lib/onboarding-logic.js';
import { loadConfig } from '../../config.js';
import { logger } from '../../lib/logger.js';

export const SETUP_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'list_available_presets',
    description:
      'Browse the agent preset catalog. Returns available agent templates grouped by business type. Use this during initial workspace setup to see what agents can be created. If business_type is provided, returns only agents for that type.',
    input_schema: {
      type: 'object' as const,
      properties: {
        business_type: {
          type: 'string',
          description: 'Filter by business type (e.g. "saas_startup", "ecommerce", "agency", "content_creator", "service_business", "consulting", "tech_company"). Omit to see all types.',
        },
      },
      required: [],
    },
  },
  {
    name: 'setup_agents',
    description:
      'Create AI agents from the preset catalog. Call this after discussing with the user which agents they need. Pass the preset IDs from list_available_presets. Only use during initial workspace setup when the user has no agents yet.',
    input_schema: {
      type: 'object' as const,
      properties: {
        preset_ids: {
          type: 'array',
          description: 'Array of preset agent IDs to create (e.g. ["saas_content_writer", "saas_data_analyst"])',
          items: { type: 'string' },
        },
        business_type: {
          type: 'string',
          description: 'Business type to scope the presets (optional, helps resolve IDs)',
        },
      },
      required: ['preset_ids'],
    },
  },
  {
    name: 'bootstrap_workspace',
    description:
      'Set up the full workspace in one call: creates a goal, AI agents from presets, and their automations/schedules. Use this during initial onboarding after understanding the user\'s goal and pain points. Prefer this over setup_agents when a goal has been identified.',
    input_schema: {
      type: 'object' as const,
      properties: {
        goal_title: {
          type: 'string',
          description: 'The user\'s primary business goal (e.g. "Grow content presence and generate consistent leads")',
        },
        goal_description: {
          type: 'string',
          description: 'Optional longer description of the goal',
        },
        goal_metric: {
          type: 'string',
          description: 'Optional metric to track (e.g. "leads_per_month", "revenue", "blog_posts")',
        },
        goal_target: {
          type: 'number',
          description: 'Optional target value for the metric (e.g. 50)',
        },
        goal_unit: {
          type: 'string',
          description: 'Optional unit for the metric (e.g. "leads", "USD", "posts")',
        },
        preset_ids: {
          type: 'array',
          description: 'Array of agent preset IDs to create',
          items: { type: 'string' },
        },
        business_type: {
          type: 'string',
          description: 'Business type to scope the presets',
        },
      },
      required: ['goal_title', 'preset_ids'],
    },
  },
];

/**
 * List available agent presets from the catalog.
 * The AI calls this to see what agents it can recommend for a business type.
 */
export async function listAvailablePresets(
  _ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const businessType = typeof input.business_type === 'string' ? input.business_type : undefined;

  if (businessType) {
    const presets = getPresetsForBusinessType(businessType);
    if (presets.length === 0) {
      const validTypes = BUSINESS_TYPES.map(bt => `${bt.id} (${bt.label})`).join(', ');
      return {
        success: false,
        error: `Unknown business type "${businessType}". Valid types: ${validTypes}`,
      };
    }
    return {
      success: true,
      data: {
        business_type: businessType,
        agents: presets.map(formatPreset),
      },
    };
  }

  // No business type: return all types with their agents
  const catalog = BUSINESS_TYPES.map(bt => ({
    id: bt.id,
    label: bt.label,
    tagline: bt.tagline,
    agents: bt.agents.map(formatPreset),
  }));

  return {
    success: true,
    data: { business_types: catalog },
  };
}

function formatPreset(p: AgentPreset) {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    description: p.description,
    department: p.department || null,
    recommended: p.recommended || false,
    tools: p.tools,
    automations: (p.automations || []).map(a => ({
      name: a.name,
      description: a.description,
      trigger: a.trigger_type,
      schedule: a.trigger_type === 'schedule'
        ? (a.trigger_config as Record<string, unknown>).cron
        : undefined,
    })),
  };
}

/**
 * Create agents from preset IDs. The AI calls this after the user confirms
 * which agents they want during the onboarding conversation.
 */
export async function setupAgents(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const presetIds = input.preset_ids;
  if (!Array.isArray(presetIds) || presetIds.length === 0) {
    return { success: false, error: 'preset_ids must be a non-empty array of agent preset IDs.' };
  }

  const businessType = typeof input.business_type === 'string'
    ? input.business_type
    : undefined;

  // Collect matching presets across all business types
  const allPresets = businessType
    ? getPresetsForBusinessType(businessType)
    : BUSINESS_TYPES.flatMap(bt => bt.agents);

  const matched: AgentPreset[] = [];
  const unknown: string[] = [];

  for (const id of presetIds) {
    if (typeof id !== 'string') continue;
    const preset = allPresets.find(p => p.id === id);
    if (preset) {
      matched.push(preset);
    } else {
      unknown.push(id);
    }
  }

  if (matched.length === 0) {
    return {
      success: false,
      error: `None of the preset IDs matched the catalog. Unknown IDs: ${unknown.join(', ')}`,
    };
  }

  // Convert presets to agents and create them
  const agents = matched.map(p => presetToAgent(p, p.department));

  let ollamaModel = 'qwen3:4b';
  try {
    const config = loadConfig();
    ollamaModel = config.ollamaModel || ollamaModel;
  } catch {
    // Use default
  }

  try {
    const presetIdMap = await createAgentsFromPresets(
      ctx.db,
      agents,
      ctx.workspaceId,
      ollamaModel,
      matched,
    );

    const created = matched.map(p => ({
      name: p.name,
      role: p.role,
      department: p.department || null,
      preset_id: p.id,
      agent_id: presetIdMap[p.id] || null,
    }));

    logger.info({ count: created.length }, '[setup_agents] Created agents from presets');

    const result: Record<string, unknown> = {
      message: `Created ${created.length} agent${created.length !== 1 ? 's' : ''}.`,
      agents: created,
    };

    if (unknown.length > 0) {
      result.warnings = [`Unknown preset IDs (skipped): ${unknown.join(', ')}`];
    }

    return { success: true, data: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create agents';
    logger.error({ err }, '[setup_agents] Error creating agents');
    return { success: false, error: msg };
  }
}

/**
 * Bootstrap the full workspace: goal + agents + automations in one call.
 * The AI calls this during the goal-first onboarding conversation.
 */
export async function bootstrapWorkspace(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const goalTitle = input.goal_title as string;
  if (!goalTitle) {
    return { success: false, error: 'goal_title is required.' };
  }

  const presetIds = input.preset_ids;
  if (!Array.isArray(presetIds) || presetIds.length === 0) {
    return { success: false, error: 'preset_ids must be a non-empty array of agent preset IDs.' };
  }

  const businessType = typeof input.business_type === 'string' ? input.business_type : undefined;

  // --- 1. Create the goal ---
  const goalId = randomUUID();
  const now = new Date().toISOString();

  try {
    await ctx.db.from('agent_workforce_goals').insert({
      id: goalId,
      workspace_id: ctx.workspaceId,
      title: goalTitle,
      description: (input.goal_description as string) || null,
      target_metric: (input.goal_metric as string) || null,
      target_value: input.goal_target != null ? Number(input.goal_target) : null,
      current_value: 0,
      unit: (input.goal_unit as string) || null,
      status: 'active',
      priority: 'high',
      color: '#6366f1',
      position: 0,
      created_at: now,
      updated_at: now,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create goal';
    logger.error({ err }, '[bootstrap_workspace] Error creating goal');
    return { success: false, error: msg };
  }

  // --- 2. Resolve presets ---
  const allPresets = businessType
    ? getPresetsForBusinessType(businessType)
    : BUSINESS_TYPES.flatMap(bt => bt.agents);

  const matched: AgentPreset[] = [];
  const unknown: string[] = [];

  for (const id of presetIds) {
    if (typeof id !== 'string') continue;
    const preset = allPresets.find(p => p.id === id);
    if (preset) matched.push(preset);
    else unknown.push(id);
  }

  if (matched.length === 0) {
    return {
      success: true,
      data: {
        message: `Goal "${goalTitle}" created, but no matching agent presets found.`,
        goal: { id: goalId, title: goalTitle },
        agents: [],
        automations: [],
        warnings: [`Unknown preset IDs: ${unknown.join(', ')}`],
      },
    };
  }

  // --- 3. Create agents + automations ---
  const agents = matched.map(p => presetToAgent(p, p.department));

  let ollamaModel = 'qwen3:4b';
  try {
    const config = loadConfig();
    ollamaModel = config.ollamaModel || ollamaModel;
  } catch {
    // Use default
  }

  try {
    const presetIdMap = await createAgentsFromPresets(
      ctx.db,
      agents,
      ctx.workspaceId,
      ollamaModel,
      matched,
    );

    const createdAgents = matched.map(p => ({
      name: p.name,
      role: p.role,
      department: p.department || null,
      preset_id: p.id,
      agent_id: presetIdMap[p.id] || null,
    }));

    // Collect operations (automations) from presets — with the agent that powers each
    const createdOperations = matched.flatMap(p =>
      (p.automations || []).map(a => ({
        name: a.name,
        description: a.description,
        trigger: a.trigger_type,
        schedule: a.trigger_type === 'schedule' ? (a.trigger_config as Record<string, unknown>)?.cron : undefined,
        powered_by: p.name,
      })),
    );

    logger.info(
      { goalId, agentCount: createdAgents.length, operationCount: createdOperations.length },
      '[bootstrap_workspace] Workspace bootstrapped',
    );

    const opLabel = createdOperations.length > 0
      ? `${createdOperations.length} active operation${createdOperations.length !== 1 ? 's' : ''}`
      : 'on-demand agents';

    const result: Record<string, unknown> = {
      message: `Workspace set up with ${opLabel}, powered by ${createdAgents.length} AI agent${createdAgents.length !== 1 ? 's' : ''}.`,
      goal: {
        id: goalId,
        title: goalTitle,
        metric: (input.goal_metric as string) || undefined,
        target: input.goal_target != null ? Number(input.goal_target) : undefined,
        unit: (input.goal_unit as string) || undefined,
      },
      operations: createdOperations,
      agents: createdAgents,
    };

    if (unknown.length > 0) {
      result.warnings = [`Unknown preset IDs (skipped): ${unknown.join(', ')}`];
    }

    return { success: true, data: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create agents';
    logger.error({ err }, '[bootstrap_workspace] Error creating agents');
    return { success: false, error: msg };
  }
}
