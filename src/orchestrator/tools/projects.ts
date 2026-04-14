/**
 * Project management orchestrator tools: list_projects, create_project,
 * update_project, get_project_board, move_task_column
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

export const PROJECT_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'list_projects',
    description:
      'Get all projects with their progress.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['active', 'completed', 'archived'] },
      },
      required: [],
    },
  },
  {
    name: 'create_project',
    description:
      'Create a new project. Confirm first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Project name' },
        description: { type: 'string', description: 'Optional description' },
        color: { type: 'string', description: 'Optional hex color' },
        due_date: { type: 'string', description: 'Optional due date (ISO 8601)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_project',
    description:
      'Update a project\'s details or status.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'The project ID' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['active', 'completed', 'archived'] },
        color: { type: 'string' },
        due_date: { type: 'string' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_project_board',
    description:
      'Get a project\'s Kanban board — tasks grouped by column.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'The project ID' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'move_task_column',
    description:
      'Move a task to a different board column.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
        board_column: { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'review', 'done'] },
      },
      required: ['task_id', 'board_column'],
    },
  },
];

export async function listProjects(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  let query = ctx.db
    .from('agent_workforce_projects')
    .select('id, name, description, status, color, due_date')
    .eq('workspace_id', ctx.workspaceId)
    .order('position', { ascending: true });

  if (input.status) {
    query = query.eq('status', input.status as string);
  }

  const { data: projects, error } = await query;
  if (error) return { success: false, error: error.message };

  const result = [];
  for (const p of (projects || []) as Array<Record<string, unknown>>) {
    const { count: totalTasks } = await ctx.db
      .from('agent_workforce_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', p.id as string)
      .is('parent_task_id', null);

    const { count: completedTasks } = await ctx.db
      .from('agent_workforce_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', p.id as string)
      .is('parent_task_id', null)
      .in('status', ['completed', 'approved']);

    result.push({
      id: p.id,
      name: p.name,
      description: p.description || undefined,
      status: p.status,
      color: p.color,
      dueDate: p.due_date || undefined,
      totalTasks: totalTasks || 0,
      completedTasks: completedTasks || 0,
    });
  }

  return { success: true, data: result };
}

export async function createProject(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const name = input.name as string;
  if (!name) return { success: false, error: 'name is required' };

  const { data: project } = await ctx.db
    .from('agent_workforce_projects')
    .insert({
      workspace_id: ctx.workspaceId,
      name,
      description: (input.description as string) || null,
      color: (input.color as string) || '#6366f1',
      due_date: input.due_date ? (input.due_date as string) : null,
      status: 'active',
    })
    .select('id, name')
    .single();

  if (!project) return { success: false, error: "Couldn't create project" };
  const p = project as { id: string; name: string };

  return {
    success: true,
    data: { message: `Project "${p.name}" created successfully.`, projectId: p.id },
  };
}

export async function updateProject(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const projectId = input.project_id as string;
  if (!projectId) return { success: false, error: 'project_id is required' };

  const { data: existing } = await ctx.db
    .from('agent_workforce_projects')
    .select('id, name, workspace_id')
    .eq('id', projectId)
    .single();

  if (!existing) return { success: false, error: 'Project not found' };
  const p = existing as { id: string; name: string; workspace_id: string };
  if (p.workspace_id !== ctx.workspaceId) return { success: false, error: 'Project not in your workspace' };

  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) payload.name = input.name;
  if (input.description !== undefined) payload.description = input.description;
  if (input.status !== undefined) payload.status = input.status;
  if (input.color !== undefined) payload.color = input.color;
  if (input.due_date !== undefined) payload.due_date = input.due_date || null;

  await ctx.db.from('agent_workforce_projects').update(payload).eq('id', projectId);

  return {
    success: true,
    data: { message: `Project "${input.name || p.name}" updated successfully.` },
  };
}

export async function getProjectBoard(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const projectId = input.project_id as string;
  if (!projectId) return { success: false, error: 'project_id is required' };

  const { data: project } = await ctx.db
    .from('agent_workforce_projects')
    .select('id, name, workspace_id')
    .eq('id', projectId)
    .single();

  if (!project) return { success: false, error: 'Project not found' };
  const p = project as { id: string; name: string; workspace_id: string };
  if (p.workspace_id !== ctx.workspaceId) return { success: false, error: 'Project not in your workspace' };

  const { data: tasks, error: tasksErr } = await ctx.db
    .from('agent_workforce_tasks')
    .select('id, title, status, agent_id, board_column')
    .eq('project_id', projectId)
    .is('parent_task_id', null)
    .is('archived_at', null)
    .order('position', { ascending: true });

  if (tasksErr) return { success: false, error: tasksErr.message };

  const rows = (tasks || []) as Array<Record<string, unknown>>;
  const agentIds = [...new Set(rows.map((t) => t.agent_id).filter(Boolean))] as string[];
  let agentMap: Record<string, string> = {};
  if (agentIds.length > 0) {
    const { data: agents } = await ctx.db.from('agent_workforce_agents').select('id, name').in('id', agentIds);
    if (agents) {
      agentMap = Object.fromEntries((agents as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
    }
  }

  const columns: Record<string, Array<{ id: string; title: string; status: string; agentName: string }>> = {
    backlog: [], todo: [], in_progress: [], review: [], done: [],
  };

  for (const t of rows) {
    const col = (t.board_column as string) || 'backlog';
    if (columns[col]) {
      columns[col].push({
        id: t.id as string,
        title: t.title as string,
        status: t.status as string,
        agentName: t.agent_id ? agentMap[t.agent_id as string] || 'Unassigned' : 'Unassigned',
      });
    }
  }

  return { success: true, data: { projectName: p.name, columns } };
}

export async function moveTaskColumn(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const taskId = input.task_id as string;
  const boardColumn = input.board_column as string;
  if (!taskId || !boardColumn) return { success: false, error: 'task_id and board_column are required' };

  const validColumns = ['backlog', 'todo', 'in_progress', 'review', 'done'];
  if (!validColumns.includes(boardColumn)) {
    return { success: false, error: `Invalid board column. Must be one of: ${validColumns.join(', ')}` };
  }

  const { data: task } = await ctx.db
    .from('agent_workforce_tasks')
    .select('id, title, workspace_id, board_column')
    .eq('id', taskId)
    .single();

  if (!task) return { success: false, error: 'Task not found' };
  const t = task as { id: string; title: string; workspace_id: string; board_column: string };
  if (t.workspace_id !== ctx.workspaceId) return { success: false, error: 'Task not in your workspace' };

  await ctx.db.from('agent_workforce_tasks').update({ board_column: boardColumn }).eq('id', taskId);

  return {
    success: true,
    data: { message: `Task "${t.title}" moved from ${t.board_column || 'backlog'} to ${boardColumn}.` },
  };
}
