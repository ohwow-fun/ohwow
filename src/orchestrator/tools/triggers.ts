/**
 * Workflow Trigger tools for the local TUI orchestrator.
 * Manages event-based triggers that auto-run workflows.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

export const WORKFLOW_TRIGGER_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'list_workflow_triggers',
    description:
      'List event-based workflow triggers. Optionally filter by workflow.',
    input_schema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'Filter by workflow ID' },
      },
      required: [],
    },
  },
  {
    name: 'create_workflow_trigger',
    description:
      'Create an event-based trigger that auto-runs a workflow. Confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'The workflow to trigger' },
        name: { type: 'string', description: 'Trigger name' },
        trigger_event: {
          type: 'string',
          enum: ['task_completed', 'task_failed', 'task_needs_approval', 'task_approved', 'task_rejected', 'human_task_completed', 'task_handoff', 'email_received', 'contact_created'],
          description: 'Event that fires the trigger',
        },
        conditions: { type: 'object', description: 'Optional conditions for the trigger' },
        cooldown_seconds: { type: 'number', description: 'Minimum seconds between trigger fires' },
        enabled: { type: 'boolean', description: 'Whether the trigger is active (default true)' },
      },
      required: ['workflow_id', 'name', 'trigger_event'],
    },
  },
  {
    name: 'update_workflow_trigger',
    description:
      'Update a workflow trigger (enable/disable, change event, reconfigure).',
    input_schema: {
      type: 'object' as const,
      properties: {
        trigger_id: { type: 'string', description: 'The trigger ID' },
        name: { type: 'string' },
        enabled: { type: 'boolean' },
        trigger_event: { type: 'string', enum: ['task_completed', 'task_failed', 'task_needs_approval', 'task_approved', 'task_rejected', 'human_task_completed', 'task_handoff', 'email_received', 'contact_created'] },
        conditions: { type: 'object' },
        cooldown_seconds: { type: 'number' },
        workflow_id: { type: 'string' },
      },
      required: ['trigger_id'],
    },
  },
  {
    name: 'delete_workflow_trigger',
    description:
      'Delete a workflow trigger. Always confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        trigger_id: { type: 'string', description: 'The trigger ID' },
      },
      required: ['trigger_id'],
    },
  },
];

const VALID_TRIGGER_EVENTS = [
  'task_completed',
  'task_failed',
  'task_needs_approval',
  'task_approved',
  'task_rejected',
  'human_task_completed',
  'task_handoff',
  'email_received',
  'contact_created',
] as const;

export async function listWorkflowTriggers(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    let query = ctx.db
      .from('agent_workforce_workflow_triggers')
      .select('id, name, workflow_id, trigger_event, enabled, conditions, cooldown_seconds, fire_count, last_fired_at')
      .eq('workspace_id', ctx.workspaceId)
      .order('created_at', { ascending: false });

    if (input.workflow_id) {
      query = query.eq('workflow_id', input.workflow_id as string);
    }

    const { data, error } = await query;
    if (error) return { success: false, error: error.message };

    return { success: true, data: data || [] };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Couldn\'t list triggers' };
  }
}

export async function createWorkflowTrigger(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const workflowId = input.workflow_id as string;
    const name = input.name as string;
    const triggerEvent = input.trigger_event as string;

    if (!workflowId) return { success: false, error: 'workflow_id is required' };
    if (!name) return { success: false, error: 'name is required' };
    if (!triggerEvent) return { success: false, error: 'trigger_event is required' };

    if (!VALID_TRIGGER_EVENTS.includes(triggerEvent as typeof VALID_TRIGGER_EVENTS[number])) {
      return { success: false, error: `Invalid trigger event. Valid events: ${VALID_TRIGGER_EVENTS.join(', ')}` };
    }

    // Verify workflow exists
    const { data: workflow } = await ctx.db
      .from('agent_workforce_workflows')
      .select('id, name')
      .eq('id', workflowId)
      .eq('workspace_id', ctx.workspaceId)
      .single();

    if (!workflow) return { success: false, error: 'Workflow not found' };

    const { data, error } = await ctx.db
      .from('agent_workforce_workflow_triggers')
      .insert({
        id: crypto.randomUUID(),
        workspace_id: ctx.workspaceId,
        workflow_id: workflowId,
        name,
        trigger_event: triggerEvent,
        conditions: input.conditions ? JSON.stringify(input.conditions) : null,
        cooldown_seconds: (input.cooldown_seconds as number) || 0,
        enabled: input.enabled !== false ? 1 : 0,
        fire_count: 0,
      })
      .select('id, name, trigger_event')
      .single();

    if (error) return { success: false, error: error.message };

    return {
      success: true,
      data: { message: `Created trigger "${name}" for workflow "${(workflow as { name: string }).name}"`, trigger: data },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Couldn\'t create trigger' };
  }
}

export async function updateWorkflowTrigger(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const triggerId = input.trigger_id as string;
    if (!triggerId) return { success: false, error: 'trigger_id is required' };

    const { data: existing } = await ctx.db
      .from('agent_workforce_workflow_triggers')
      .select('id')
      .eq('id', triggerId)
      .eq('workspace_id', ctx.workspaceId)
      .single();

    if (!existing) return { success: false, error: 'Trigger not found' };

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.name) updates.name = input.name;
    if (input.enabled !== undefined) updates.enabled = input.enabled ? 1 : 0;
    if (input.trigger_event) {
      if (!VALID_TRIGGER_EVENTS.includes(input.trigger_event as typeof VALID_TRIGGER_EVENTS[number])) {
        return { success: false, error: `Invalid trigger event. Valid events: ${VALID_TRIGGER_EVENTS.join(', ')}` };
      }
      updates.trigger_event = input.trigger_event;
    }
    if (input.conditions !== undefined) updates.conditions = input.conditions ? JSON.stringify(input.conditions) : null;
    if (input.cooldown_seconds !== undefined) updates.cooldown_seconds = input.cooldown_seconds;
    if (input.workflow_id) updates.workflow_id = input.workflow_id;

    const { error } = await ctx.db
      .from('agent_workforce_workflow_triggers')
      .update(updates)
      .eq('id', triggerId);

    if (error) return { success: false, error: error.message };

    return { success: true, data: { message: 'Trigger updated' } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Couldn\'t update trigger' };
  }
}

export async function deleteWorkflowTrigger(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const triggerId = input.trigger_id as string;
    if (!triggerId) return { success: false, error: 'trigger_id is required' };

    const { data: existing } = await ctx.db
      .from('agent_workforce_workflow_triggers')
      .select('id, name')
      .eq('id', triggerId)
      .eq('workspace_id', ctx.workspaceId)
      .single();

    if (!existing) return { success: false, error: 'Trigger not found' };

    const { error } = await ctx.db
      .from('agent_workforce_workflow_triggers')
      .delete()
      .eq('id', triggerId);

    if (error) return { success: false, error: error.message };

    return { success: true, data: { message: `Deleted trigger: ${(existing as { name: string }).name}` } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Couldn\'t delete trigger' };
  }
}
