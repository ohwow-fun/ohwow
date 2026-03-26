/**
 * Onboarding Logic
 * Shared business logic for the unified onboarding wizard.
 * Used by both TUI (Ink) and Web UI (React) via API routes.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { BUSINESS_TYPES, type AgentPreset, type BusinessType, type PresetAutomation } from '../tui/data/agent-presets.js';
import { AutomationService } from '../triggers/automation-service.js';
import { MCP_SERVER_CATALOG } from '../mcp/catalog.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorkspaceData {
  businessName: string;
  businessType: string;
  businessDescription: string;
  founderPath: string;
  founderFocus: string;
}

export interface AgentToCreate {
  id: string;
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  department?: string;
}

export const FOUNDER_PATHS = [
  { id: 'exploring', label: 'Exploring ideas', description: 'Still figuring out what to build' },
  { id: 'just_starting', label: 'Just starting', description: 'Building the first version' },
  { id: 'no_revenue', label: 'Pre-revenue', description: 'Launched but not making money yet' },
  { id: 'making_money', label: 'Making money', description: 'Revenue is coming in' },
] as const;

export type FounderPath = typeof FOUNDER_PATHS[number]['id'];

// ── Database Operations ─────────────────────────────────────────────────────

/** Save workspace/business info to the local SQLite database. */
export async function saveWorkspaceData(
  db: DatabaseAdapter,
  workspaceId: string,
  data: WorkspaceData,
): Promise<void> {
  const now = new Date().toISOString();

  // Try update first, then insert
  const { data: existing } = await db.from('agent_workforce_workspaces')
    .select('id')
    .eq('id', workspaceId)
    .maybeSingle();

  if (existing) {
    await db.from('agent_workforce_workspaces')
      .update({
        business_name: data.businessName,
        business_type: data.businessType,
        business_description: data.businessDescription,
        founder_path: data.founderPath,
        founder_focus: data.founderFocus,
        onboarding_complete: 1,
        updated_at: now,
      })
      .eq('id', workspaceId);
  } else {
    await db.from('agent_workforce_workspaces')
      .insert({
        id: workspaceId,
        business_name: data.businessName,
        business_type: data.businessType,
        business_description: data.businessDescription,
        founder_path: data.founderPath,
        founder_focus: data.founderFocus,
        onboarding_complete: 1,
        created_at: now,
        updated_at: now,
      });
  }

  // Also save business_name to runtime_settings for the dashboard
  const { data: existingSetting } = await db.from('runtime_settings')
    .select('key')
    .eq('key', 'business_name')
    .maybeSingle();

  if (existingSetting) {
    await db.from('runtime_settings')
      .update({ value: data.businessName, updated_at: now })
      .eq('key', 'business_name');
  } else {
    await db.from('runtime_settings')
      .insert({ key: 'business_name', value: data.businessName });
  }
}

/** Create agents from preset selections during onboarding. Returns a map of preset ID → real agent ID. */
export async function createAgentsFromPresets(
  db: DatabaseAdapter,
  agents: AgentToCreate[],
  workspaceId: string,
  ollamaModel: string,
  presets?: AgentPreset[],
): Promise<Record<string, string>> {
  const presetIdToAgentId: Record<string, string> = {};

  for (const agent of agents) {
    // Generate a hex ID
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const agentId = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

    presetIdToAgentId[agent.id] = agentId;

    // Create department if specified and not already existing
    let departmentId: string | null = null;
    if (agent.department) {
      const { data: existingDept } = await db.from('agent_workforce_departments')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('name', agent.department)
        .maybeSingle();

      if (existingDept) {
        departmentId = (existingDept as { id: string }).id;
      } else {
        const deptBytes = new Uint8Array(16);
        crypto.getRandomValues(deptBytes);
        departmentId = Array.from(deptBytes, b => b.toString(16).padStart(2, '0')).join('');
        await db.from('agent_workforce_departments').insert({
          id: departmentId,
          workspace_id: workspaceId,
          name: agent.department,
          sort_order: 0,
        });
      }
    }

    await db.from('agent_workforce_agents').insert({
      id: agentId,
      workspace_id: workspaceId,
      department_id: departmentId,
      name: agent.name,
      role: agent.role,
      description: agent.description || '',
      system_prompt: agent.systemPrompt,
      config: JSON.stringify({
        model: ollamaModel || 'qwen3:4b',
        temperature: 0.7,
        max_tokens: 4096,
        tools_enabled: agent.tools || [],
        approval_required: false,
        web_search_enabled: true,
      }),
      status: 'idle',
      stats: JSON.stringify({
        total_tasks: 0,
        completed_tasks: 0,
        failed_tasks: 0,
        tokens_used: 0,
        cost_cents: 0,
      }),
      is_preset: 1,
      memory_document: '',
      memory_token_count: 0,
    });

    // Log the creation
    db.rpc('create_agent_activity', {
      p_workspace_id: workspaceId,
      p_activity_type: 'agent_created',
      p_title: `${agent.name} created during onboarding`,
      p_description: `Role: ${agent.role}`,
      p_agent_id: agentId,
      p_task_id: null,
      p_metadata: { runtime: true, source: 'onboarding_wizard' },
    });
  }

  // Create automations from presets if provided
  if (presets) {
    await createAutomationsFromPresets(db, presets, presetIdToAgentId, workspaceId);
  }

  return presetIdToAgentId;
}

/** Create automations from preset agent definitions after agent creation. */
export async function createAutomationsFromPresets(
  db: DatabaseAdapter,
  presets: AgentPreset[],
  presetIdToAgentId: Record<string, string>,
  workspaceId: string,
): Promise<void> {
  const automationService = new AutomationService(db, workspaceId);

  for (const preset of presets) {
    if (!preset.automations?.length) continue;
    if (!presetIdToAgentId[preset.id]) continue;

    for (const automation of preset.automations) {
      const resolvedSteps = automation.steps.map(step => ({
        id: step.id,
        step_type: step.step_type as import('../triggers/automation-service.js').AutomationStepType,
        label: step.label,
        agent_id: step.agent_ref ? presetIdToAgentId[step.agent_ref] || step.agent_ref : undefined,
        prompt: step.prompt,
        action_config: step.action_config,
      }));

      await automationService.create({
        name: automation.name,
        description: automation.description,
        trigger_type: automation.trigger_type,
        trigger_config: automation.trigger_config,
        steps: resolvedSteps,
        cooldown_seconds: automation.cooldown_seconds,
      });
    }
  }
}

/** Collect unique required MCP server IDs from selected presets. */
export function collectRequiredMcpServers(presets: AgentPreset[]): string[] {
  const ids = new Set<string>();
  for (const preset of presets) {
    if (preset.requiredMcpServers) {
      for (const id of preset.requiredMcpServers) ids.add(id);
    }
  }
  return Array.from(ids);
}

/** Configure MCP servers for agents that require them. Saves to runtime_settings. */
export async function configureMcpServersForAgents(
  db: DatabaseAdapter,
  mcpServerIds: string[],
  envValues: Record<string, string>,
): Promise<void> {
  if (mcpServerIds.length === 0) return;

  const servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};

  for (const serverId of mcpServerIds) {
    const entry = MCP_SERVER_CATALOG.find(s => s.id === serverId);
    if (!entry) continue;

    const serverEnv: Record<string, string> = {};
    for (const envVar of entry.envVarsRequired) {
      if (envValues[envVar.key]) {
        serverEnv[envVar.key] = envValues[envVar.key];
      }
    }

    servers[serverId] = {
      command: entry.command,
      args: entry.args,
      env: serverEnv,
    };
  }

  const now = new Date().toISOString();
  const { data: existing } = await db.from('runtime_settings')
    .select('key')
    .eq('key', 'global_mcp_servers')
    .maybeSingle();

  const value = JSON.stringify(servers);

  if (existing) {
    await db.from('runtime_settings')
      .update({ value, updated_at: now })
      .eq('key', 'global_mcp_servers');
  } else {
    await db.from('runtime_settings')
      .insert({ key: 'global_mcp_servers', value });
  }
}

/**
 * Detect OpenClaw installation and return integration info for the onboarding wizard.
 */
export async function collectOpenClawIntegration(): Promise<{
  installed: boolean;
  path: string;
  version: string;
}> {
  try {
    const { detectOpenClawInstall } = await import('../integrations/openclaw/security.js');
    return detectOpenClawInstall();
  } catch {
    return { installed: false, path: '', version: '' };
  }
}

// ── Agent Discovery Prompts ─────────────────────────────────────────────────

/** Build the system prompt for the AI agent discovery chat. */
export function buildAgentDiscoveryPrompt(
  businessType: string,
  founderPath: string,
  founderFocus: string,
  presetCatalog: AgentPreset[],
): string {
  const presetList = presetCatalog
    .map(p => `- ${p.id}: ${p.name} (${p.role}) — ${p.description}`)
    .join('\n');

  const pathLabel = FOUNDER_PATHS.find(p => p.id === founderPath)?.label || founderPath;
  const typeLabel = BUSINESS_TYPES.find(bt => bt.id === businessType)?.label || businessType;

  return `You are a friendly AI advisor helping a founder figure out their top goal and build an AI team around it.

Context about the user:
- Business type: ${typeLabel}
- Stage: ${pathLabel}
- Current focus: ${founderFocus || 'not specified'}

Available agents you can recommend:
${presetList}

Your conversation flow:
1. First, ask about their #1 goal right now. What does success look like in the next 30 days?
2. Then ask what takes the most time or falls through the cracks.
3. After 2-3 exchanges, recommend a concrete goal and 2-4 agents that will help them hit it.

When you make your final recommendation, include a \`\`\`setup JSON block like this:

\`\`\`setup
{
  "goal": "Goal title here",
  "goal_metric": "optional_metric_name",
  "goal_target": 50,
  "agents": ["preset_id_1", "preset_id_2"]
}
\`\`\`

The "goal" field is a short, action-oriented title (e.g. "Get to 20 paying customers").
The "goal_metric" is an optional snake_case metric name (e.g. "paying_customers").
The "goal_target" is an optional numeric target value.
The "agents" array contains preset IDs from the list above.

Guidelines:
- Keep responses SHORT (2-3 sentences max per turn)
- Be warm and conversational, not corporate
- Ask one focused question at a time
- After 2-3 exchanges, give your recommendation with the \`\`\`setup block
- Only recommend agents from the available list above`;
}

/** Parse agent IDs from the model's response. */
export function parseAgentRecommendations(response: string): string[] {
  // Look for ```agents block
  const agentBlockMatch = response.match(/```agents\s*\n?([\s\S]*?)```/);
  if (agentBlockMatch) {
    try {
      const parsed = JSON.parse(agentBlockMatch[1].trim());
      if (Array.isArray(parsed)) return parsed.filter(id => typeof id === 'string');
    } catch {
      // Fall through to regex
    }
  }

  // Fallback: look for JSON array in the text
  const arrayMatch = response.match(/\[[\s\S]*?\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) return parsed.filter(id => typeof id === 'string');
    } catch {
      // No valid JSON
    }
  }

  return [];
}

// ── Discovery Result Parsing ────────────────────────────────────────────────

export interface DiscoveryResult {
  goal: { title: string; metric?: string; target?: number; unit?: string } | null;
  agentIds: string[];
}

/** Parse a ```setup JSON block from the model's response. Falls back to parseAgentRecommendations(). */
export function parseDiscoveryResult(response: string): DiscoveryResult {
  // Try to parse ```setup JSON block
  const setupBlockMatch = response.match(/```setup\s*\n?([\s\S]*?)```/);
  if (setupBlockMatch) {
    try {
      const parsed = JSON.parse(setupBlockMatch[1].trim()) as {
        goal?: string;
        goal_metric?: string;
        goal_target?: number;
        unit?: string;
        agents?: string[];
      };

      const goal = parsed.goal
        ? {
            title: parsed.goal,
            metric: parsed.goal_metric || undefined,
            target: parsed.goal_target != null ? parsed.goal_target : undefined,
            unit: parsed.unit || undefined,
          }
        : null;

      const agentIds = Array.isArray(parsed.agents)
        ? parsed.agents.filter((id): id is string => typeof id === 'string')
        : [];

      return { goal, agentIds };
    } catch {
      // Fall through to legacy parsing
    }
  }

  // Fall back to parseAgentRecommendations() for backward compat
  const agentIds = parseAgentRecommendations(response);
  return { goal: null, agentIds };
}

/** Get static recommendations when no model is available (fallback). */
export function getStaticRecommendations(businessType: string): AgentPreset[] {
  const bt = BUSINESS_TYPES.find(t => t.id === businessType);
  if (!bt) return [];
  return bt.agents.filter(a => a.recommended);
}

/** Get all presets for a business type. */
export function getPresetsForBusinessType(businessType: string): AgentPreset[] {
  const bt = BUSINESS_TYPES.find(t => t.id === businessType);
  return bt?.agents ?? [];
}

/** Get all business types for the selection screen. */
export function getBusinessTypes(): BusinessType[] {
  return BUSINESS_TYPES;
}

/** Convert AgentPreset to AgentToCreate. */
export function presetToAgent(preset: AgentPreset, department?: string): AgentToCreate {
  return {
    id: preset.id,
    name: preset.name,
    role: preset.role,
    description: preset.description,
    systemPrompt: preset.systemPrompt,
    tools: preset.tools,
    department,
  };
}
