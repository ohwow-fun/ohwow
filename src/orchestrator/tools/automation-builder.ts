/**
 * Automation Builder tools (local runtime version):
 * discover_capabilities — surveys local agents, triggers, and channels
 * propose_automation — validates and returns an automation proposal
 * create_automation — creates and saves an automation via AutomationService
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { AutomationService } from '../../triggers/automation-service.js';
import type { AutomationStepType } from '../../triggers/automation-service.js';

export const AUTOMATION_BUILDER_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'discover_capabilities',
    description:
      'Survey the workspace to discover what agents, triggers, step types, and channels are available for building an automation. Call this FIRST when the user describes an automation intent.',
    input_schema: {
      type: 'object' as const,
      properties: {
        intent: {
          type: 'string',
          description: 'The user\'s automation intent in natural language',
        },
      },
      required: ['intent'],
    },
  },
  {
    name: 'propose_automation',
    description:
      'Propose a complete automation for the user to review. Always call discover_capabilities first, then ask clarifying questions, then call this.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Short name for the automation' },
        description: { type: 'string', description: 'What this automation does' },
        reasoning: {
          type: 'string',
          description: 'Your reasoning for this design. Shown to the user as a "Thinking" section.',
        },
        trigger: {
          type: 'object',
          description: 'The trigger that starts this automation',
          properties: {
            type: { type: 'string', enum: ['webhook', 'schedule', 'event', 'manual'] },
            config: { type: 'object', description: 'Trigger configuration' },
          },
          required: ['type'],
        },
        steps: {
          type: 'array',
          description: 'Ordered list of automation steps',
          items: {
            type: 'object',
            properties: {
              step_type: {
                type: 'string',
                enum: [
                  'agent_prompt', 'a2a_call', 'run_agent', 'save_contact', 'update_contact',
                  'log_contact_event', 'webhook_forward', 'transform_data', 'conditional',
                  'create_task', 'send_notification', 'fill_pdf', 'save_attachment',
                  'take_screenshot', 'generate_chart',
                ],
              },
              label: { type: 'string', description: 'Human-readable label' },
              agent_id: { type: 'string' },
              agent_name: { type: 'string' },
              prompt: { type: 'string' },
              action_config: { type: 'object' },
              required_integrations: { type: 'array', items: { type: 'string' } },
            },
            required: ['step_type', 'label'],
          },
        },
        variables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              default_value: { type: 'string' },
            },
            required: ['name', 'description'],
          },
        },
      },
      required: ['name', 'description', 'reasoning', 'trigger', 'steps'],
    },
  },
  {
    name: 'create_automation',
    description:
      'Create and save an automation directly. Use this after propose_automation when the user confirms they want to create it (e.g. says "yes", "create it", "looks good"). This saves the automation immediately without requiring a UI approval step.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Short name for the automation' },
        description: { type: 'string', description: 'What this automation does' },
        trigger: {
          type: 'object',
          description: 'The trigger that starts this automation',
          properties: {
            type: { type: 'string', enum: ['webhook', 'schedule', 'event', 'manual'], description: 'Trigger type' },
            config: { type: 'object', description: 'Trigger configuration (e.g., cron expression, event type)' },
          },
          required: ['type'],
        },
        steps: {
          type: 'array',
          description: 'Ordered list of automation steps (same format as propose_automation)',
          items: {
            type: 'object',
            properties: {
              step_type: {
                type: 'string',
                enum: [
                  'agent_prompt', 'a2a_call', 'run_agent', 'save_contact', 'update_contact',
                  'log_contact_event', 'webhook_forward', 'transform_data', 'conditional',
                  'create_task', 'send_notification', 'fill_pdf', 'save_attachment',
                  'take_screenshot', 'generate_chart',
                ],
                description: 'Type of step',
              },
              label: { type: 'string', description: 'Human-readable label for this step' },
              agent_id: { type: 'string', description: 'Agent ID (for agent_prompt/run_agent steps)' },
              agent_name: { type: 'string', description: 'Agent name (for display)' },
              prompt: { type: 'string', description: 'Task prompt for the agent' },
              action_config: { type: 'object', description: 'All step settings' },
              required_integrations: {
                type: 'array',
                items: { type: 'string' },
                description: 'Integration providers this step requires',
              },
            },
            required: ['step_type', 'label'],
          },
        },
        variables: {
          type: 'array',
          description: 'Optional automation variables',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              default_value: { type: 'string' },
            },
            required: ['name', 'description'],
          },
        },
      },
      required: ['name', 'description', 'trigger', 'steps'],
    },
  },
];

// Step type labels (mirrored from web app's automation types)
const STEP_TYPE_LABELS: Record<string, string> = {
  agent_prompt: 'AI Agent',
  a2a_call: 'External Agent (A2A)',
  run_agent: 'Run Agent',
  save_contact: 'Save Contact',
  update_contact: 'Update Contact',
  log_contact_event: 'Log Event',
  webhook_forward: 'Forward Webhook',
  transform_data: 'Transform Data',
  conditional: 'Conditional',
  create_task: 'Create Task',
  send_notification: 'Send Notification',
  fill_pdf: 'Fill PDF',
  save_attachment: 'Save Attachment',
  take_screenshot: 'Take Screenshot',
  generate_chart: 'Generate Chart',
};

const STEP_TYPE_DESCRIPTIONS: Record<string, string> = {
  agent_prompt: 'Have an AI agent process data and generate a response',
  a2a_call: 'Call an external agent via the A2A protocol',
  run_agent: 'Assign a task to an AI agent with context from the trigger',
  save_contact: 'Create or update a contact from the data',
  update_contact: 'Find and update an existing contact',
  log_contact_event: 'Add a timeline event to an existing contact',
  webhook_forward: 'Forward the data to an external URL',
  transform_data: 'Transform and reshape data between steps',
  conditional: 'Branch execution based on a condition',
  create_task: 'Create a task in a project board',
  send_notification: 'Send a message via WhatsApp, Slack, or Telegram',
  fill_pdf: 'Fill a PDF template with data from previous steps',
  save_attachment: 'Save a file to workspace storage',
  take_screenshot: 'Navigate to a URL and capture a screenshot',
  generate_chart: 'Create a chart image from data',
};

// ─── discover_capabilities ──────────────────────────────────────────────────

export async function discoverCapabilities(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const intent = (input.intent as string) || '';
  if (!intent) return { success: false, error: 'intent is required' };

  try {
    // Load local agents
    const { data: agents, error: agentsErr } = await ctx.db
      .from('agent_workforce_agents')
      .select('id, name, role')
      .eq('workspace_id', ctx.workspaceId)
      .eq('paused', 0);

    if (agentsErr) return { success: false, error: agentsErr.message };

    const agentSummaries = ((agents || []) as Array<{ id: string; name: string; role: string }>).map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      department: 'General',
    }));

    // Load existing local triggers
    const { data: triggers } = await ctx.db
      .from('local_triggers')
      .select('id, name, event_type, trigger_type')
      .eq('enabled', 1)
      .limit(20);

    const existingTriggers = ((triggers || []) as Array<{ id: string; name: string; event_type: string; trigger_type: string }>).map((t) => ({
      id: t.id,
      name: t.name,
      type: t.trigger_type || 'webhook',
      eventType: t.event_type,
    }));

    // Built-in step types
    const stepTypes = Object.entries(STEP_TYPE_LABELS).map(([type, label]) => ({
      type,
      label,
      description: STEP_TYPE_DESCRIPTIONS[type] || '',
    }));

    // Trigger types
    const triggerTypes = [
      { type: 'webhook', label: 'Webhook', description: 'Fires when an external service sends data to a URL' },
      { type: 'schedule', label: 'Schedule', description: 'Runs on a cron schedule' },
      { type: 'event', label: 'Event', description: 'Fires when an internal event occurs' },
      { type: 'manual', label: 'Manual', description: 'Triggered manually' },
    ];

    // Check channel capabilities
    const channelStatus: Record<string, boolean> = {};
    const intentLower = intent.toLowerCase();

    if (intentLower.includes('whatsapp') && ctx.channels) {
      const whatsapp = ctx.channels.get('whatsapp');
      channelStatus.whatsapp = whatsapp ? whatsapp.getStatus().connected : false;
    }
    if (intentLower.includes('telegram') && ctx.channels) {
      const telegram = ctx.channels.get('telegram');
      channelStatus.telegram = telegram ? telegram.getStatus().connected : false;
    }

    const missing: string[] = [];
    if (intentLower.includes('whatsapp') && !channelStatus.whatsapp) {
      missing.push('WhatsApp is not connected');
    }
    if (intentLower.includes('telegram') && !channelStatus.telegram) {
      missing.push('Telegram is not connected');
    }
    if (agentSummaries.length === 0 && intentLower.match(/agent|ai|process|analyze/)) {
      missing.push('No active agents found. Create agents first.');
    }

    return {
      success: true,
      data: {
        agents: agentSummaries,
        existingTriggers,
        stepTypes,
        triggerTypes,
        channelStatus,
        missingCapabilities: missing,
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Couldn\'t discover capabilities' };
  }
}

// ─── propose_automation ─────────────────────────────────────────────────────

export async function proposeAutomation(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const name = input.name as string;
  const description = input.description as string;
  const reasoning = input.reasoning as string;
  const trigger = input.trigger as { type: string; config: Record<string, unknown> };
  const steps = input.steps as Array<{
    step_type: string;
    label: string;
    agent_id?: string;
    agent_name?: string;
    prompt?: string;
    action_config?: Record<string, unknown>;
    required_integrations?: string[];
  }>;
  const variables = input.variables as Array<{
    name: string;
    description: string;
    default_value?: string;
  }> | undefined;

  if (!name) return { success: false, error: 'name is required' };
  if (!reasoning) return { success: false, error: 'reasoning is required' };
  if (!trigger?.type) return { success: false, error: 'trigger.type is required' };
  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    return { success: false, error: 'steps array is required and must not be empty' };
  }

  // Validate agent IDs
  const agentIdsUsed = steps.map((s) => s.agent_id).filter((id): id is string => !!id);

  let agentMap = new Map<string, string>();
  if (agentIdsUsed.length > 0) {
    const { data: agentRows } = await ctx.db
      .from('agent_workforce_agents')
      .select('id, name')
      .in('id', agentIdsUsed);

    agentMap = new Map(
      ((agentRows || []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name])
    );
  }

  const validatedSteps = steps.map((step, i) => {
    const resolvedAgentName = step.agent_id
      ? agentMap.get(step.agent_id) || step.agent_name || 'Unknown agent'
      : step.agent_name;
    const invalidAgent = step.agent_id && !agentMap.has(step.agent_id);

    return {
      id: `step_${i + 1}`,
      step_type: step.step_type,
      label: step.label || STEP_TYPE_LABELS[step.step_type] || `Step ${i + 1}`,
      agent_id: step.agent_id,
      agent_name: resolvedAgentName,
      prompt: step.prompt,
      action_config: step.action_config,
      required_integrations: step.required_integrations,
      ...(invalidAgent ? { warning: `Agent "${step.agent_id}" not found` } : {}),
    };
  });

  return {
    success: true,
    data: {
      message: 'Automation proposed. Waiting for user review.',
      _automationProposal: {
        name,
        description: description || '',
        reasoning,
        trigger,
        steps: validatedSteps,
        variables: variables || [],
        missingIntegrations: [],
      },
    },
  };
}

// ─── create_automation ─────────────────────────────────────────────────────

export async function createAutomation(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const name = input.name as string;
  const description = input.description as string;
  const trigger = input.trigger as { type: string; config?: Record<string, unknown> };
  const steps = input.steps as Array<{
    step_type: string;
    label?: string;
    agent_id?: string;
    agent_name?: string;
    prompt?: string;
    action_config?: Record<string, unknown>;
    required_integrations?: string[];
  }>;
  const variables = input.variables as Array<{
    name: string;
    description: string;
    default_value?: string;
  }> | undefined;

  if (!name) return { success: false, error: 'name is required' };
  if (!trigger?.type) return { success: false, error: 'trigger.type is required' };
  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    return { success: false, error: 'steps array is required and must not be empty' };
  }

  try {
    // Normalize steps — merge top-level fields into action_config
    const normalizedSteps = steps.map((step, i) => {
      const config: Record<string, unknown> = { ...(step.action_config || {}) };
      if (step.step_type === 'run_agent' || step.step_type === 'agent_prompt') {
        if (step.agent_id && !config.agent_id) config.agent_id = step.agent_id;
        if (step.agent_name && !config.agent_name) config.agent_name = step.agent_name;
        if (step.prompt && !config.task_prompt) config.task_prompt = step.prompt;
      }
      return {
        id: `step_${i + 1}`,
        step_type: step.step_type as AutomationStepType,
        label: step.label || STEP_TYPE_LABELS[step.step_type] || `Step ${i + 1}`,
        agent_id: step.agent_id || (config.agent_id as string | undefined),
        agent_name: step.agent_name || (config.agent_name as string | undefined),
        prompt: step.prompt || (config.task_prompt as string | undefined),
        action_config: config,
        required_integrations: step.required_integrations,
      };
    });

    const service = new AutomationService(ctx.db, ctx.workspaceId);
    const automation = await service.create({
      name,
      description: description || undefined,
      trigger_type: trigger.type as 'webhook' | 'schedule' | 'event' | 'manual',
      trigger_config: trigger.config || {},
      steps: normalizedSteps,
      variables: variables?.map((v) => ({
        name: v.name,
        description: v.description,
        default_value: v.default_value,
      })),
    });

    // Notify scheduler so new cron triggers are picked up
    ctx.onScheduleChange?.();

    return {
      success: true,
      data: {
        automation_id: automation.id,
        name: automation.name,
        message: 'Automation created and active!',
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Couldn\'t create automation' };
  }
}
