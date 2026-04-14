/**
 * Goal management orchestrator tools (local runtime):
 * list_goals, create_goal, update_goal, link_task_to_goal, link_project_to_goal
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { randomUUID } from 'node:crypto';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { syncResource, hexToUuid, type SyncPayload } from '../../control-plane/sync-resources.js';
import { logger } from '../../lib/logger.js';

export const GOAL_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'list_goals',
    description:
      'Get all strategic goals with their progress.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['active', 'completed', 'paused', 'archived'] },
      },
      required: [],
    },
  },
  {
    name: 'create_goal',
    description:
      'Create a new strategic goal. Confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'The goal title' },
        description: { type: 'string', description: 'Why this goal matters' },
        target_metric: { type: 'string', description: 'Metric name (e.g., "MRR")' },
        target_value: { type: 'number', description: 'Target value' },
        current_value: { type: 'number', description: 'Current value' },
        unit: { type: 'string', description: 'Unit (e.g., "$", "%")' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        due_date: { type: 'string', description: 'Target date (ISO 8601)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_goal',
    description:
      'Update a goal\'s details, status, or metric progress.',
    input_schema: {
      type: 'object' as const,
      properties: {
        goal_id: { type: 'string', description: 'The goal ID' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['active', 'completed', 'paused', 'archived'] },
        current_value: { type: 'number' },
        target_value: { type: 'number' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      },
      required: ['goal_id'],
    },
  },
  {
    name: 'link_task_to_goal',
    description:
      'Link a task to a strategic goal for business context.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
        goal_id: { type: 'string', description: 'The goal ID (empty to unlink)' },
      },
      required: ['task_id', 'goal_id'],
    },
  },
  {
    name: 'link_project_to_goal',
    description:
      'Link a project to a strategic goal.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'The project ID' },
        goal_id: { type: 'string', description: 'The goal ID (empty to unlink)' },
      },
      required: ['project_id', 'goal_id'],
    },
  },
];

/** Reshape a local agent_workforce_goals row into the cloud sync payload. */
export function goalSyncPayload(row: Record<string, unknown>): SyncPayload {
  return {
    id: hexToUuid(row.id as string),
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    status: (row.status as string | null) ?? 'active',
    priority: (row.priority as string | null) ?? 'normal',
    target_metric: (row.target_metric as string | null) ?? null,
    target_value: row.target_value ?? null,
    current_value: row.current_value ?? 0,
    unit: (row.unit as string | null) ?? null,
    due_date: (row.due_date as string | null) ?? null,
    color: (row.color as string | null) ?? '#6366f1',
    position: row.position ?? 0,
    completed_at: (row.completed_at as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

/** Re-fetch a goal row and sync upstream. Never throws. */
export async function syncGoalById(ctx: LocalToolContext, goalId: string): Promise<void> {
  try {
    const { data } = await ctx.db
      .from('agent_workforce_goals')
      .select('*')
      .eq('id', goalId)
      .eq('workspace_id', ctx.workspaceId)
      .maybeSingle();
    if (!data) return;
    void syncResource(ctx, 'goal', 'upsert', goalSyncPayload(data as Record<string, unknown>));
  } catch (err) {
    logger.debug({ err, goalId }, '[goals] sync re-fetch failed');
  }
}

export async function listGoals(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  let query = ctx.db
    .from('agent_workforce_goals')
    .select('id, title, description, status, priority, target_metric, target_value, current_value, unit, due_date, color')
    .eq('workspace_id', ctx.workspaceId)
    .order('position', { ascending: true });

  if (input.status) {
    query = query.eq('status', input.status as string);
  }

  const { data: goals, error } = await query;
  if (error) return { success: false, error: error.message };

  const result = [];
  for (const g of (goals || []) as Array<Record<string, unknown>>) {
    const [taskTotal, taskCompleted, projectCount] = await Promise.all([
      ctx.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true }).eq('goal_id', g.id as string),
      ctx.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true }).eq('goal_id', g.id as string).in('status', ['completed', 'approved']),
      ctx.db.from('agent_workforce_projects').select('id', { count: 'exact', head: true }).eq('goal_id', g.id as string),
    ]);

    const total = taskTotal.count || 0;
    const completed = taskCompleted.count || 0;
    let percentComplete: number;
    if (g.target_value && (g.target_value as number) > 0) {
      percentComplete = Math.min(100, Math.round(((g.current_value as number) || 0) / (g.target_value as number) * 100));
    } else {
      percentComplete = total > 0 ? Math.round((completed / total) * 100) : 0;
    }

    result.push({
      id: g.id,
      title: g.title,
      description: g.description || undefined,
      status: g.status,
      priority: g.priority,
      targetMetric: g.target_metric || undefined,
      targetValue: g.target_value ?? undefined,
      currentValue: g.current_value ?? 0,
      unit: g.unit || undefined,
      dueDate: g.due_date || undefined,
      color: g.color,
      totalTasks: total,
      completedTasks: completed,
      linkedProjects: projectCount.count || 0,
      percentComplete,
    });
  }

  return { success: true, data: result };
}

export async function createGoal(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const title = input.title as string;
  if (!title) return { success: false, error: 'title is required' };

  // Get max position
  const { data: maxPos } = await ctx.db
    .from('agent_workforce_goals')
    .select('position')
    .eq('workspace_id', ctx.workspaceId)
    .order('position', { ascending: false })
    .limit(1)
    .single();

  const nextPosition = ((maxPos as Record<string, unknown> | null)?.position as number ?? -1) + 1;

  const id = randomUUID();
  const now = new Date().toISOString();

  const { error } = await ctx.db
    .from('agent_workforce_goals')
    .insert({
      id,
      workspace_id: ctx.workspaceId,
      title,
      description: (input.description as string) || null,
      target_metric: (input.target_metric as string) || null,
      target_value: input.target_value != null ? Number(input.target_value) : null,
      current_value: input.current_value != null ? Number(input.current_value) : 0,
      unit: (input.unit as string) || null,
      priority: (input.priority as string) || 'normal',
      due_date: (input.due_date as string) || null,
      color: '#6366f1',
      position: nextPosition,
      created_at: now,
      updated_at: now,
    });

  if (error) return { success: false, error: error.message };
  void syncGoalById(ctx, id);

  return {
    success: true,
    data: { message: `Goal "${title}" created successfully.`, goalId: id },
  };
}

export async function updateGoal(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const goalId = input.goal_id as string;
  if (!goalId) return { success: false, error: 'goal_id is required' };

  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) updateData.title = input.title;
  if (input.status !== undefined) {
    updateData.status = input.status;
    if (input.status === 'completed') updateData.completed_at = new Date().toISOString();
  }
  if (input.current_value !== undefined) updateData.current_value = Number(input.current_value);
  if (input.target_value !== undefined) updateData.target_value = Number(input.target_value);
  if (input.priority !== undefined) updateData.priority = input.priority;
  if (input.due_date !== undefined) updateData.due_date = input.due_date || null;

  const { error } = await ctx.db
    .from('agent_workforce_goals')
    .update(updateData)
    .eq('id', goalId);

  if (error) return { success: false, error: error.message };
  void syncGoalById(ctx, goalId);

  return { success: true, data: { message: 'Goal updated successfully.' } };
}

export async function linkTaskToGoal(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const taskId = input.task_id as string;
  const goalId = input.goal_id as string;
  if (!taskId) return { success: false, error: 'task_id is required' };

  const { error } = await ctx.db
    .from('agent_workforce_tasks')
    .update({ goal_id: goalId || null })
    .eq('id', taskId);

  if (error) return { success: false, error: error.message };

  return {
    success: true,
    data: { message: goalId ? 'Task linked to goal.' : 'Task unlinked from goal.' },
  };
}

export async function linkProjectToGoal(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const projectId = input.project_id as string;
  const goalId = input.goal_id as string;
  if (!projectId) return { success: false, error: 'project_id is required' };

  const { error } = await ctx.db
    .from('agent_workforce_projects')
    .update({ goal_id: goalId || null })
    .eq('id', projectId);

  if (error) return { success: false, error: error.message };

  return {
    success: true,
    data: { message: goalId ? 'Project linked to goal.' : 'Project unlinked from goal.' },
  };
}
