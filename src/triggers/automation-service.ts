/**
 * Automation Service
 *
 * CRUD service for automations using the unified cloud schema.
 * Stores steps/variables/node_positions in a `definition` JSON column
 * on local_triggers, matching the cloud's agent_workforce_workflows.definition format.
 *
 * Also syncs legacy columns (actions, action_type, action_config) so the
 * trigger evaluator continues to work during the transition.
 */

import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { LocalTrigger } from '../webhooks/ghl-types.js';
import type { AutomationAction } from './automation-types.js';

// ============================================================================
// Types (mirrors cloud Automation shape)
// ============================================================================

export type AutomationTriggerType = 'webhook' | 'schedule' | 'event' | 'manual';

export type AutomationStepType =
  | 'agent_prompt'
  | 'a2a_call'
  | 'save_contact'
  | 'update_contact'
  | 'log_contact_event'
  | 'webhook_forward'
  | 'transform_data'
  | 'conditional'
  | 'run_agent'
  | 'create_task'
  | 'send_notification'
  | 'fill_pdf'
  | 'save_attachment'
  | 'take_screenshot'
  | 'generate_chart'
  | 'shell_script';

export interface AutomationStep {
  id: string;
  step_type: AutomationStepType;
  label?: string;
  agent_id?: string;
  agent_name?: string;
  prompt?: string;
  image_url?: string;
  required_integrations?: string[];
  connection_id?: string;
  action_config?: Record<string, unknown>;
}

export interface AutomationVariable {
  name: string;
  description: string;
  default_value?: string;
}

export interface Automation {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger_type: AutomationTriggerType;
  trigger_config: Record<string, unknown>;
  steps: AutomationStep[];
  variables?: AutomationVariable[];
  node_positions?: Record<string, { x: number; y: number }>;
  cooldown_seconds: number;
  last_fired_at: string | null;
  fire_count: number;
  sample_payload?: Record<string, unknown> | null;
  sample_fields?: string[] | null;
  status: 'draft' | 'active' | 'paused' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface CreateAutomationInput {
  name: string;
  description?: string;
  trigger_type: AutomationTriggerType;
  trigger_config?: Record<string, unknown>;
  steps: AutomationStep[];
  variables?: AutomationVariable[];
  cooldown_seconds?: number;
  node_positions?: Record<string, { x: number; y: number }>;
  event_type?: string;
  source?: string;
  sample_payload?: Record<string, unknown> | null;
  sample_fields?: string[] | null;
}

export interface UpdateAutomationInput {
  name?: string;
  description?: string;
  trigger_type?: AutomationTriggerType;
  trigger_config?: Record<string, unknown>;
  steps?: AutomationStep[];
  variables?: AutomationVariable[];
  cooldown_seconds?: number;
  node_positions?: Record<string, { x: number; y: number }>;
  enabled?: boolean;
  sample_payload?: Record<string, unknown> | null;
  sample_fields?: string[] | null;
  source?: string;
}

interface AutomationDefinition {
  steps: AutomationStep[];
  variables?: AutomationVariable[];
  node_positions?: Record<string, { x: number; y: number }>;
}

// ============================================================================
// Service
// ============================================================================

export class AutomationService {
  constructor(
    private db: DatabaseAdapter,
    private workspaceId: string,
  ) {}

  /** List all non-archived automations */
  async list(): Promise<Automation[]> {
    const { data } = await this.db.from<LocalTrigger>('local_triggers')
      .select('*')
      .order('created_at', { ascending: false });

    if (!data) return [];

    return (data ?? [])
      .filter((t) => t.status !== 'archived')
      .map((t) => this.toAutomation(t));
  }

  /** Get a single automation by ID */
  async getById(id: string): Promise<Automation | null> {
    const { data } = await this.db.from<LocalTrigger>('local_triggers')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (!data) return null;
    return this.toAutomation(data);
  }

  /** Create a new automation */
  async create(input: CreateAutomationInput): Promise<Automation> {
    const definition: AutomationDefinition = {
      steps: input.steps,
      variables: input.variables,
      node_positions: input.node_positions,
    };

    // Sync legacy columns for evaluator compatibility
    const legacyActions = this.stepsToActions(input.steps);
    const firstAction = legacyActions[0];

    // Derive event_type and source from trigger_config or input
    const eventType = input.event_type
      || (input.trigger_config?.event_type as string)
      || 'custom';
    const source = input.source
      || (input.trigger_config?.source as string)
      || 'ghl';

    const insertData: Record<string, unknown> = {
      name: input.name,
      description: input.description || '',
      source,
      event_type: eventType,
      conditions: JSON.stringify(input.trigger_config?.conditions || {}),
      action_type: firstAction?.action_type || 'run_agent',
      action_config: JSON.stringify(firstAction?.action_config || {}),
      cooldown_seconds: input.cooldown_seconds ?? 60,
      actions: JSON.stringify(legacyActions),
      trigger_type: input.trigger_type || 'webhook',
      trigger_config: JSON.stringify(input.trigger_config || {}),
      variables: input.variables ? JSON.stringify(input.variables) : null,
      node_positions: input.node_positions ? JSON.stringify(input.node_positions) : null,
      definition: JSON.stringify(definition),
      status: 'active',
      sample_payload: input.sample_payload ? JSON.stringify(input.sample_payload) : null,
      sample_fields: input.sample_fields ? JSON.stringify(input.sample_fields) : null,
    };

    // Auto-generate webhook token for custom event type
    if (eventType === 'custom') {
      insertData.webhook_token = crypto.randomBytes(16).toString('hex');
    }

    const { data } = await this.db.from<LocalTrigger>('local_triggers')
      .insert(insertData)
      .select('*')
      .single();

    return this.toAutomation(data!);
  }

  /** Update an existing automation */
  async update(id: string, input: UpdateAutomationInput): Promise<Automation | null> {
    const existing = await this.getById(id);
    if (!existing) return null;

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;

    if (input.enabled !== undefined) {
      updates.enabled = input.enabled ? 1 : 0;
      updates.status = input.enabled ? 'active' : 'paused';
    }

    if (input.cooldown_seconds !== undefined) {
      updates.cooldown_seconds = input.cooldown_seconds;
    }

    if (input.trigger_type !== undefined) {
      updates.trigger_type = input.trigger_type;
    }

    if (input.trigger_config !== undefined) {
      updates.trigger_config = JSON.stringify(input.trigger_config);
      if (input.trigger_config.conditions) {
        updates.conditions = JSON.stringify(input.trigger_config.conditions);
      }
      if (input.trigger_config.event_type) {
        updates.event_type = input.trigger_config.event_type;
      }
      if (input.trigger_config.source) {
        updates.source = input.trigger_config.source;
      }
    }

    if (input.source !== undefined) {
      updates.source = input.source;
    }

    if (input.sample_payload !== undefined) {
      updates.sample_payload = input.sample_payload ? JSON.stringify(input.sample_payload) : null;
    }
    if (input.sample_fields !== undefined) {
      updates.sample_fields = input.sample_fields ? JSON.stringify(input.sample_fields) : null;
    }

    // Rebuild definition from input (merging with existing)
    const steps = input.steps ?? existing.steps;
    const variables = input.variables ?? existing.variables;
    const nodePositions = input.node_positions ?? existing.node_positions;

    const definition: AutomationDefinition = {
      steps,
      variables,
      node_positions: nodePositions,
    };

    updates.definition = JSON.stringify(definition);

    // Sync legacy columns
    if (input.steps !== undefined) {
      const legacyActions = this.stepsToActions(input.steps);
      updates.actions = JSON.stringify(legacyActions);
      if (legacyActions.length > 0) {
        updates.action_type = legacyActions[0].action_type;
        updates.action_config = JSON.stringify(legacyActions[0].action_config);
      }
    }

    if (input.variables !== undefined) {
      updates.variables = input.variables ? JSON.stringify(input.variables) : null;
    }
    if (input.node_positions !== undefined) {
      updates.node_positions = input.node_positions ? JSON.stringify(input.node_positions) : null;
    }

    await this.db.from('local_triggers').update(updates).eq('id', id);
    return this.getById(id);
  }

  /** Soft delete (archive) an automation */
  async delete(id: string): Promise<void> {
    await this.db.from('local_triggers').update({
      status: 'archived',
      enabled: 0,
      updated_at: new Date().toISOString(),
    }).eq('id', id);
  }

  // ============================================================================
  // Internal converters
  // ============================================================================

  /** Convert a LocalTrigger row to the unified Automation format */
  private toAutomation(trigger: LocalTrigger): Automation {
    let steps: AutomationStep[];
    let variables: AutomationVariable[] | undefined;
    let nodePositions: Record<string, { x: number; y: number }> | undefined;

    // Prefer definition column (new format)
    if (trigger.definition) {
      try {
        const def = JSON.parse(trigger.definition) as AutomationDefinition;
        steps = def.steps || [];
        variables = def.variables;
        nodePositions = def.node_positions;
      } catch {
        // Fall through to legacy
        steps = this.legacyToSteps(trigger);
        variables = this.parseLegacyVariables(trigger);
        nodePositions = this.parseLegacyNodePositions(trigger);
      }
    } else {
      // Legacy: reconstruct from actions/action_type columns
      steps = this.legacyToSteps(trigger);
      variables = this.parseLegacyVariables(trigger);
      nodePositions = this.parseLegacyNodePositions(trigger);
    }

    // Parse trigger_config
    let triggerType: AutomationTriggerType = 'webhook';
    let triggerConfig: Record<string, unknown> = {};

    if (trigger.trigger_type) {
      triggerType = trigger.trigger_type as AutomationTriggerType;
    }
    if (trigger.trigger_config) {
      try { triggerConfig = JSON.parse(trigger.trigger_config); } catch { /* empty */ }
    } else {
      triggerConfig = {
        source: trigger.source || 'ghl',
        event_type: trigger.event_type,
      };
      try {
        const conditions = JSON.parse(trigger.conditions);
        if (Object.keys(conditions).length > 0) {
          triggerConfig.conditions = conditions;
        }
      } catch { /* empty */ }
    }

    let samplePayload: Record<string, unknown> | null = null;
    let sampleFields: string[] | null = null;
    if (trigger.sample_payload) {
      try { samplePayload = JSON.parse(trigger.sample_payload); } catch { /* empty */ }
    }
    if (trigger.sample_fields) {
      try { sampleFields = JSON.parse(trigger.sample_fields); } catch { /* empty */ }
    }

    // Determine status
    let status: Automation['status'] = 'active';
    if (trigger.status) {
      status = trigger.status as Automation['status'];
    } else {
      status = trigger.enabled === 1 ? 'active' : 'paused';
    }

    return {
      id: trigger.id,
      workspace_id: this.workspaceId,
      name: trigger.name,
      description: trigger.description || null,
      enabled: trigger.enabled === 1,
      trigger_type: triggerType,
      trigger_config: triggerConfig,
      steps,
      variables,
      node_positions: nodePositions,
      cooldown_seconds: trigger.cooldown_seconds,
      last_fired_at: trigger.last_fired_at,
      fire_count: trigger.fire_count,
      sample_payload: samplePayload,
      sample_fields: sampleFields,
      status,
      created_at: trigger.created_at,
      updated_at: trigger.updated_at,
    };
  }

  /** Convert legacy actions/action_type columns to AutomationStep[] */
  private legacyToSteps(trigger: LocalTrigger): AutomationStep[] {
    if (trigger.actions) {
      try {
        const actions = JSON.parse(trigger.actions) as AutomationAction[];
        if (Array.isArray(actions) && actions.length > 0) {
          return actions.map((action) => this.actionToStep(action));
        }
      } catch { /* fall through */ }
    }

    // Single-action fallback
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(trigger.action_config); } catch { /* empty */ }

    return [{
      id: 'step_1',
      step_type: trigger.action_type as AutomationStepType,
      label: trigger.action_type,
      action_config: config,
    }];
  }

  /** Convert a single AutomationAction to an AutomationStep */
  private actionToStep(action: AutomationAction): AutomationStep {
    return {
      id: action.id,
      step_type: action.action_type as AutomationStepType,
      label: action.label,
      action_config: action.action_config,
      ...(action.action_type === 'run_agent' ? {
        agent_id: action.action_config.agent_id as string | undefined,
        prompt: action.action_config.task_prompt as string | undefined,
      } : {}),
      ...(action.action_config.image_url ? {
        image_url: action.action_config.image_url as string,
      } : {}),
    };
  }

  /** Convert AutomationStep[] to AutomationAction[] for legacy columns */
  private stepsToActions(steps: AutomationStep[]): AutomationAction[] {
    return steps.map((step) => ({
      id: step.id,
      action_type: step.step_type,
      action_config: step.action_config || {
        ...(step.agent_id ? { agent_id: step.agent_id } : {}),
        ...(step.agent_name ? { agent_name: step.agent_name } : {}),
        ...(step.prompt ? { task_prompt: step.prompt } : {}),
        ...(step.connection_id ? { connection_id: step.connection_id } : {}),
        ...(step.required_integrations ? { required_integrations: step.required_integrations } : {}),
        ...(step.image_url ? { image_url: step.image_url } : {}),
      },
      label: step.label,
    }));
  }

  private parseLegacyVariables(trigger: LocalTrigger): AutomationVariable[] | undefined {
    if (!trigger.variables) return undefined;
    try { return JSON.parse(trigger.variables); } catch { return undefined; }
  }

  private parseLegacyNodePositions(trigger: LocalTrigger): Record<string, { x: number; y: number }> | undefined {
    if (!trigger.node_positions) return undefined;
    try { return JSON.parse(trigger.node_positions); } catch { return undefined; }
  }
}
