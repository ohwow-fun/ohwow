/**
 * Schedule orchestrator tools: get_agent_schedules, update_agent_schedule
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

export async function getAgentSchedules(ctx: LocalToolContext): Promise<ToolResult> {
  const { data, error } = await ctx.db
    .from('agent_workforce_schedules')
    .select('id, agent_id, workflow_id, label, cron, enabled, next_run_at, task_prompt')
    .eq('workspace_id', ctx.workspaceId)
    .order('created_at', { ascending: false });

  if (error) return { success: false, error: error.message };

  const rows = (data || []) as Array<Record<string, unknown>>;
  const agentIds = [...new Set(rows.map((s) => s.agent_id).filter(Boolean))] as string[];
  const workflowIds = [...new Set(rows.map((s) => s.workflow_id).filter(Boolean))] as string[];

  let agentMap: Record<string, string> = {};
  let workflowMap: Record<string, string> = {};

  if (agentIds.length > 0) {
    const { data: agents } = await ctx.db.from('agent_workforce_agents').select('id, name').in('id', agentIds);
    if (agents) agentMap = Object.fromEntries((agents as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
  }
  if (workflowIds.length > 0) {
    const { data: workflows } = await ctx.db.from('agent_workforce_workflows').select('id, name').in('id', workflowIds);
    if (workflows) workflowMap = Object.fromEntries((workflows as Array<{ id: string; name: string }>).map((w) => [w.id, w.name]));
  }

  const result = rows.map((s) => ({
    scheduleId: s.id,
    agentId: s.agent_id,
    workflowId: s.workflow_id,
    name: s.agent_id
      ? agentMap[s.agent_id as string] || 'Unknown'
      : workflowMap[s.workflow_id as string] || 'Unknown',
    type: s.agent_id ? 'agent' : 'workflow',
    label: s.label,
    cron: s.cron,
    enabled: s.enabled,
    nextRunAt: s.next_run_at || null,
  }));

  return { success: true, data: result };
}

export async function updateAgentSchedule(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const scheduleId = input.schedule_id as string;
  const agentId = input.agent_id as string;
  const workflowId = input.workflow_id as string;
  const cron = input.cron as string;
  const enabled = input.enabled !== undefined ? (input.enabled as boolean) : true;
  const label = input.label as string | undefined;
  const taskPrompt = input.task_prompt as string | undefined;

  if (!cron) return { success: false, error: 'cron is required' };
  if (!isValidCron(cron)) {
    return { success: false, error: `Invalid cron expression: "${cron}". Expected format: "minute hour day month weekday"` };
  }

  // Compute next_run_at
  let nextRunAt: string | null = null;
  if (enabled) {
    try {
      const { CronExpressionParser } = await import('cron-parser');
      const interval = CronExpressionParser.parse(cron);
      nextRunAt = interval.next().toISOString();
    } catch { /* leave null */ }
  }

  // Update existing schedule
  if (scheduleId) {
    const { data: schedule } = await ctx.db
      .from('agent_workforce_schedules')
      .select('id, workspace_id')
      .eq('id', scheduleId)
      .single();

    if (!schedule) return { success: false, error: 'Schedule not found' };
    if ((schedule as { workspace_id: string }).workspace_id !== ctx.workspaceId) {
      return { success: false, error: 'Schedule not in your workspace' };
    }

    const updatePayload: Record<string, unknown> = { cron, enabled: enabled ? 1 : 0, next_run_at: nextRunAt };
    if (label !== undefined) updatePayload.label = label;
    if (taskPrompt !== undefined) updatePayload.task_prompt = taskPrompt;

    await ctx.db.from('agent_workforce_schedules').update(updatePayload).eq('id', scheduleId);
    ctx.onScheduleChange?.();

    return {
      success: true,
      data: { message: `Schedule updated: ${cron} (${enabled ? 'enabled' : 'disabled'})` },
    };
  }

  // Create new schedule
  if (!agentId && !workflowId) return { success: false, error: 'agent_id, workflow_id, or schedule_id is required' };

  let targetName = 'Unknown';
  if (agentId) {
    const { data: agent } = await ctx.db.from('agent_workforce_agents').select('id, name, workspace_id').eq('id', agentId).single();
    if (!agent) return { success: false, error: 'Agent not found' };
    const a = agent as { workspace_id: string; name: string };
    if (a.workspace_id !== ctx.workspaceId) return { success: false, error: 'Agent not in your workspace' };
    targetName = a.name;
  } else {
    const { data: workflow } = await ctx.db.from('agent_workforce_workflows').select('id, name, workspace_id').eq('id', workflowId).single();
    if (!workflow) return { success: false, error: 'Workflow not found' };
    const w = workflow as { workspace_id: string; name: string };
    if (w.workspace_id !== ctx.workspaceId) return { success: false, error: 'Workflow not in your workspace' };
    targetName = w.name;
  }

  const insertPayload: Record<string, unknown> = {
    workspace_id: ctx.workspaceId,
    cron,
    enabled: enabled ? 1 : 0,
    next_run_at: nextRunAt,
  };
  if (agentId) insertPayload.agent_id = agentId;
  if (workflowId) insertPayload.workflow_id = workflowId;
  if (label) insertPayload.label = label;
  if (taskPrompt) insertPayload.task_prompt = taskPrompt;

  await ctx.db.from('agent_workforce_schedules').insert(insertPayload);
  ctx.onScheduleChange?.();

  return {
    success: true,
    data: { message: `Schedule for "${targetName}" created: ${cron} (${enabled ? 'enabled' : 'disabled'})` },
  };
}

function isValidCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const patterns = [
    /^(\*|(\d{1,2})([-/,]\d{1,2})*)$/,
    /^(\*|(\d{1,2})([-/,]\d{1,2})*)$/,
    /^(\*|(\d{1,2})([-/,]\d{1,2})*)$/,
    /^(\*|(\d{1,2})([-/,]\d{1,2})*)$/,
    /^(\*|(\d{1})([-/,]\d{1})*)$/,
  ];
  return parts.every((part, i) => patterns[i].test(part));
}
