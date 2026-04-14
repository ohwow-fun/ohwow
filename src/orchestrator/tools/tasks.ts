/**
 * Task orchestrator tools: list_tasks, get_task_detail, get_pending_approvals,
 * approve_task, reject_task, queue_task, retry_task, cancel_task
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { logger } from '../../lib/logger.js';
import { syncResource, hexToUuid, type SyncPayload } from '../../control-plane/sync-resources.js';

/**
 * Reshape a local agent_workforce_tasks row for the cloud sync-resource
 * upsert. Translates local 'person' assignee_type into the cloud's
 * 'human' constraint, and pulls the team_member id (which the local
 * row stores in `assigned_to` for human-owned tasks) into the
 * dedicated cloud column `assigned_team_member_id`. The cloud
 * `assigned_to` column references workspace_members and we don't have
 * that mapping from the runtime, so it gets nulled.
 */
export function taskSyncPayload(row: Record<string, unknown>): SyncPayload {
  const assigneeType = (row.assignee_type as string | null) ?? 'agent';
  const isHuman = assigneeType === 'person' || assigneeType === 'human';
  const localAssignedTo = (row.assigned_to as string | null) ?? null;
  let metadata: unknown = row.metadata;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      metadata = null;
    }
  }
  let input: unknown = row.input;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { /* leave as string */ }
  }
  let output: unknown = row.output;
  if (typeof output === 'string') {
    try { output = JSON.parse(output); } catch { /* leave as string */ }
  }
  return {
    id: hexToUuid(row.id as string),
    agent_id: row.agent_id ? hexToUuid(row.agent_id as string) : null,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    status: row.status,
    priority: (row.priority as string | null) ?? 'normal',
    assignee_type: isHuman ? 'human' : 'agent',
    assigned_team_member_id: isHuman && localAssignedTo ? hexToUuid(localAssignedTo) : null,
    assigned_to: null,
    assigned_at: row.assigned_at ?? null,
    goal_id: row.goal_id ? hexToUuid(row.goal_id as string) : null,
    // project_id intentionally omitted from sync — cloud projects are
    // not yet mirrored, so a non-null value would FK-violate against
    // agent_workforce_projects. The runtime is the source of truth for
    // project assignment until projects join the synced registry.
    project_id: null,
    metadata,
    input,
    output,
    source_type: (row.source_type as string | null) ?? 'manual',
    requires_approval: row.requires_approval ?? false,
    model_used: row.model_used ?? null,
    tokens_used: row.tokens_used ?? 0,
    cost_cents: row.cost_cents ?? 0,
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
    duration_seconds: row.duration_seconds ?? null,
    error_message: row.error_message ?? null,
    due_date: row.due_date ?? null,
    created_at: row.created_at ?? null,
  };
}

/** Re-fetch a task row from the local DB and sync it upstream. Never throws. */
export async function syncTaskById(ctx: LocalToolContext, taskId: string): Promise<void> {
  try {
    const { data } = await ctx.db
      .from('agent_workforce_tasks')
      .select('*')
      .eq('id', taskId)
      .eq('workspace_id', ctx.workspaceId)
      .maybeSingle();
    if (!data) return;
    void syncResource(ctx, 'task', 'upsert', taskSyncPayload(data as Record<string, unknown>));
  } catch (err) {
    logger.debug({ err, taskId }, '[tasks] sync re-fetch failed');
  }
}

export async function listTasks(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  // Bumped from 10 → 50 in response to the E4 fuzz finding: real
  // workspaces routinely have 100+ tasks, and the prior default hid
  // so much of the table that the orchestrator repeatedly miscounted
  // in the B0.13 bench. Still clamp to [1, 500] so a runaway prompt
  // can't pull the whole table.
  const rawLimit = typeof input.limit === 'number' ? (input.limit as number) : 50;
  const limit = Math.max(1, Math.min(500, Math.floor(rawLimit)));

  let query = ctx.db
    .from('agent_workforce_tasks')
    .select('id, title, status, agent_id, project_id, board_column, created_at, tokens_used, cost_cents, error_message')
    .eq('workspace_id', ctx.workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (input.status) query = query.eq('status', input.status as string);
  if (input.agent_id) query = query.eq('agent_id', input.agent_id as string);
  if (input.project_id) query = query.eq('project_id', input.project_id as string);

  const { data, error } = await query;
  if (error) return { success: false, error: error.message };

  // Total-count companion query — lets the caller tell whether the
  // returned page is the whole set or only the first `limit` rows.
  // Mirrors the same filter stack as the data query so total and
  // rows count the same population.
  let totalCountQuery = ctx.db
    .from('agent_workforce_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ctx.workspaceId);
  if (input.status) totalCountQuery = totalCountQuery.eq('status', input.status as string);
  if (input.agent_id) totalCountQuery = totalCountQuery.eq('agent_id', input.agent_id as string);
  if (input.project_id) totalCountQuery = totalCountQuery.eq('project_id', input.project_id as string);
  const { count: totalCount } = await totalCountQuery;

  // Resolve agent names
  const rows = (data || []) as Array<Record<string, unknown>>;
  const agentIds = [...new Set(rows.map((t) => t.agent_id).filter(Boolean))] as string[];
  let agentMap: Record<string, string> = {};
  if (agentIds.length > 0) {
    const { data: agents } = await ctx.db.from('agent_workforce_agents').select('id, name').in('id', agentIds);
    if (agents) {
      agentMap = Object.fromEntries((agents as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
    }
  }

  // Resolve project names
  const projectIds = [...new Set(rows.map((t) => t.project_id).filter(Boolean))] as string[];
  let projectMap: Record<string, string> = {};
  if (projectIds.length > 0) {
    const { data: projects } = await ctx.db.from('agent_workforce_projects').select('id, name').in('id', projectIds);
    if (projects) {
      projectMap = Object.fromEntries((projects as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]));
    }
  }

  const tasks = rows.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    agentName: t.agent_id ? agentMap[t.agent_id as string] || 'Unknown' : 'Unknown',
    projectName: t.project_id ? projectMap[t.project_id as string] || undefined : undefined,
    boardColumn: t.board_column || undefined,
    createdAt: t.created_at,
    error: t.error_message || undefined,
  }));

  return {
    success: true,
    data: {
      total: totalCount ?? tasks.length,
      returned: tasks.length,
      limit,
      tasks,
    },
  };
}

export async function getTaskDetail(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const taskId = input.task_id as string;
  if (!taskId) return { success: false, error: 'task_id is required' };

  const { data: task } = await ctx.db
    .from('agent_workforce_tasks')
    .select('id, title, description, status, agent_id, output, error_message, tokens_used, cost_cents, model_used, created_at, completed_at, duration_seconds, retry_count, project_id, board_column, workspace_id')
    .eq('id', taskId)
    .single();

  if (!task) return { success: false, error: 'Task not found' };
  const t = task as Record<string, unknown>;
  if (t.workspace_id !== ctx.workspaceId) return { success: false, error: 'Task not in your workspace' };

  // Resolve agent name
  let agentName = 'Unknown';
  if (t.agent_id) {
    const { data: agent } = await ctx.db.from('agent_workforce_agents').select('name').eq('id', t.agent_id as string).single();
    if (agent) agentName = (agent as { name: string }).name;
  }

  // Truncate output if very large
  let output = t.output;
  if (output && typeof output === 'string' && output.length > 3000) {
    output = output.slice(0, 3000) + '... (truncated)';
  }

  return {
    success: true,
    data: {
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      agentName,
      output,
      errorMessage: t.error_message || undefined,
      tokensUsed: t.tokens_used,
      costCents: t.cost_cents,
      modelUsed: t.model_used,
      createdAt: t.created_at,
      completedAt: t.completed_at,
      durationSeconds: t.duration_seconds,
      retryCount: t.retry_count,
      boardColumn: t.board_column || undefined,
    },
  };
}

export async function getPendingApprovals(ctx: LocalToolContext): Promise<ToolResult> {
  const { data, error } = await ctx.db
    .from('agent_workforce_tasks')
    .select('id, title, agent_id, created_at, output')
    .eq('workspace_id', ctx.workspaceId)
    .eq('status', 'needs_approval')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return { success: false, error: error.message };

  const rows = (data || []) as Array<Record<string, unknown>>;
  const agentIds = [...new Set(rows.map((t) => t.agent_id).filter(Boolean))] as string[];
  let agentMap: Record<string, string> = {};
  if (agentIds.length > 0) {
    const { data: agents } = await ctx.db.from('agent_workforce_agents').select('id, name').in('id', agentIds);
    if (agents) {
      agentMap = Object.fromEntries((agents as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
    }
  }

  const result = rows.map((t) => ({
    id: t.id,
    title: t.title,
    agentName: t.agent_id ? agentMap[t.agent_id as string] || 'Unknown' : 'Unknown',
    createdAt: t.created_at,
    outputPreview: t.output ? String(t.output).slice(0, 200) : undefined,
  }));

  return { success: true, data: result };
}

export async function approveTask(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const taskId = input.task_id as string;
  if (!taskId) return { success: false, error: 'task_id is required' };

  const { data: task } = await ctx.db
    .from('agent_workforce_tasks')
    .select('id, title, status, workspace_id, deferred_action')
    .eq('id', taskId)
    .single();

  if (!task) return { success: false, error: 'Task not found' };
  const t = task as { id: string; title: string; status: string; workspace_id: string; deferred_action: unknown };
  if (t.workspace_id !== ctx.workspaceId) return { success: false, error: 'Task not in your workspace' };
  if (t.status !== 'needs_approval') return { success: false, error: `Task is not pending approval (status: ${t.status})` };

  const now = new Date().toISOString();
  await ctx.db.from('agent_workforce_tasks').update({
    status: 'approved',
    approved_at: now,
    approved_by: 'runtime',
    updated_at: now,
  }).eq('id', taskId);
  void syncTaskById(ctx, taskId);

  // Execute deferred action if present via the control plane
  let actionMessage = '';
  if (t.deferred_action) {
    const action = typeof t.deferred_action === 'string'
      ? JSON.parse(t.deferred_action) as { type: string; params: Record<string, unknown>; provider: string }
      : t.deferred_action as { type: string; params: Record<string, unknown>; provider: string };

    if (ctx.controlPlane) {
      const result = await ctx.controlPlane.executeDeferredAction(taskId, action);
      if (result.success) {
        actionMessage = ` Deferred action (${action.type}) executed successfully.`;
      } else {
        actionMessage = ` Warning: deferred action failed: ${result.error}`;
      }
    } else {
      actionMessage = ` Note: deferred action (${action.type}) requires cloud connection to execute.`;
    }
  }

  return { success: true, data: { message: `Task "${t.title}" has been approved.${actionMessage}` } };
}

export async function rejectTask(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const taskId = input.task_id as string;
  const reason = (input.reason as string) || 'Rejected via orchestrator';
  const retry = input.retry === true;
  if (!taskId) return { success: false, error: 'task_id is required' };

  const { data: task } = await ctx.db
    .from('agent_workforce_tasks')
    .select('id, title, description, input, output, status, workspace_id, agent_id, requires_approval, project_id, board_column, priority, labels')
    .eq('id', taskId)
    .single();

  if (!task) return { success: false, error: 'Task not found' };
  const t = task as Record<string, unknown>;
  if (t.workspace_id !== ctx.workspaceId) return { success: false, error: 'Task not in your workspace' };
  if (t.status !== 'needs_approval') return { success: false, error: `Task is not pending approval (status: ${t.status})` };

  const now = new Date().toISOString();
  await ctx.db.from('agent_workforce_tasks').update({
    status: 'rejected',
    rejection_reason: reason,
    updated_at: now,
  }).eq('id', taskId);
  void syncTaskById(ctx, taskId);

  // Update deliverable record if one exists
  const { data: deliverable } = await ctx.db
    .from('agent_workforce_deliverables')
    .select('id')
    .eq('task_id', taskId)
    .single();

  if (deliverable) {
    await ctx.db.from('agent_workforce_deliverables').update({
      status: 'rejected',
      reviewed_by: 'runtime',
      reviewed_at: now,
      rejection_reason: reason,
      updated_at: now,
    }).eq('id', (deliverable as { id: string }).id);
  }

  // Handle retry if requested
  if (retry && t.agent_id) {
    const retryInput = typeof t.input === 'string' ? t.input : JSON.stringify(t.input);
    const outputPreview = typeof t.output === 'object'
      ? ((t.output as Record<string, unknown>)?.text || JSON.stringify(t.output))
      : String(t.output || '');

    const retryDescription = [
      (t.description as string) || '',
      '\n---\n**Your previous attempt was rejected.**',
      `**Rejection reason:** ${reason}`,
      `**Previous output (summary):** ${String(outputPreview).slice(0, 1500)}`,
      '\nPlease revise based on this feedback.',
    ].join('\n');

    const retryPayload: Record<string, unknown> = {
      workspace_id: ctx.workspaceId,
      agent_id: t.agent_id,
      title: `[Retry] ${t.title}`,
      description: retryDescription,
      input: retryInput,
      status: 'pending',
      priority: t.priority || 'normal',
      requires_approval: t.requires_approval ?? true,
      parent_task_id: taskId,
      board_column: 'todo',
    };
    if (t.project_id) retryPayload.project_id = t.project_id;
    if (t.labels) retryPayload.labels = t.labels;

    const { data: newTask } = await ctx.db
      .from('agent_workforce_tasks')
      .insert(retryPayload)
      .select('id')
      .single();

    if (newTask) {
      const newTaskId = (newTask as { id: string }).id;
      void syncTaskById(ctx, newTaskId);
      ctx.engine.executeTask(t.agent_id as string, newTaskId).catch((err) => {
        logger.error(`[orchestrator:reject_task] Retry execution failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      return {
        success: true,
        data: { message: `Task "${t.title}" rejected. Retry created (task ID: ${newTaskId})` },
      };
    }
  }

  return { success: true, data: { message: `Task "${t.title}" has been rejected. Reason: ${reason}` } };
}

export async function scheduleTask(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const agentId = input.agent_id as string;
  const prompt = input.prompt as string;
  const title = (input.title as string) || prompt.slice(0, 100);

  if (!agentId || !prompt) return { success: false, error: 'agent_id and prompt are required' };

  const { data: agent } = await ctx.db
    .from('agent_workforce_agents')
    .select('id, name, workspace_id')
    .eq('id', agentId)
    .single();

  if (!agent) return { success: false, error: 'Agent not found' };
  const a = agent as { id: string; name: string; workspace_id: string };
  if (a.workspace_id !== ctx.workspaceId) return { success: false, error: 'Agent not in your workspace' };

  const insertPayload: Record<string, unknown> = {
    workspace_id: ctx.workspaceId,
    agent_id: agentId,
    title,
    input: prompt,
    status: 'pending',
  };
  if (input.project_id) insertPayload.project_id = input.project_id as string;

  const { data: task } = await ctx.db
    .from('agent_workforce_tasks')
    .insert(insertPayload)
    .select('id')
    .single();

  if (!task) return { success: false, error: "Couldn't create task" };
  const newTaskId = (task as { id: string }).id;
  void syncTaskById(ctx, newTaskId);

  return {
    success: true,
    data: { message: `Task scheduled for ${a.name}: "${title}" (task ID: ${newTaskId})` },
  };
}

export async function retryTask(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const taskId = input.task_id as string;
  if (!taskId) return { success: false, error: 'task_id is required' };

  const { data: task } = await ctx.db
    .from('agent_workforce_tasks')
    .select('id, title, status, agent_id, input, workspace_id, description, project_id, board_column')
    .eq('id', taskId)
    .single();

  if (!task) return { success: false, error: 'Task not found' };
  const t = task as Record<string, unknown>;
  if (t.workspace_id !== ctx.workspaceId) return { success: false, error: 'Task not in your workspace' };
  if (t.status !== 'failed') return { success: false, error: `Can only retry failed tasks (current status: ${t.status})` };

  const retryPayload: Record<string, unknown> = {
    workspace_id: ctx.workspaceId,
    agent_id: t.agent_id,
    title: `Retry: ${t.title}`,
    description: t.description,
    input: t.input,
    status: 'pending',
    retry_count: 0,
  };
  if (t.project_id) retryPayload.project_id = t.project_id;
  if (t.board_column) retryPayload.board_column = t.board_column;

  const { data: newTask } = await ctx.db
    .from('agent_workforce_tasks')
    .insert(retryPayload)
    .select('id')
    .single();

  if (!newTask) return { success: false, error: "Couldn't retry task" };
  const newTaskId = (newTask as { id: string }).id;
  void syncTaskById(ctx, newTaskId);

  // Execute via engine
  ctx.engine.executeTask(t.agent_id as string, newTaskId).catch((err) => {
    logger.error(`[orchestrator:retry_task] Execution failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  return {
    success: true,
    data: { message: `Retry task created for "${t.title}" (new task ID: ${newTaskId})` },
  };
}

export async function cancelTask(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const taskId = input.task_id as string;
  if (!taskId) return { success: false, error: 'task_id is required' };

  const { data: task } = await ctx.db
    .from('agent_workforce_tasks')
    .select('id, title, status, workspace_id')
    .eq('id', taskId)
    .single();

  if (!task) return { success: false, error: 'Task not found' };
  const t = task as { id: string; title: string; status: string; workspace_id: string };
  if (t.workspace_id !== ctx.workspaceId) return { success: false, error: 'Task not in your workspace' };

  if (!['pending', 'in_progress'].includes(t.status)) {
    return { success: false, error: `Cannot cancel task with status "${t.status}". Only pending or running tasks can be cancelled.` };
  }

  await ctx.db.from('agent_workforce_tasks').update({
    status: 'failed',
    error_message: 'Cancelled by user via orchestrator',
  }).eq('id', taskId);
  void syncTaskById(ctx, taskId);

  return { success: true, data: { message: `Task "${t.title}" has been cancelled.` } };
}
