/**
 * Workspace orchestrator tools: get_workspace_stats, get_activity_feed
 * (Removed get_credits and get_integration_status — not applicable to local runtime)
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

export async function getWorkspaceStats(ctx: LocalToolContext): Promise<ToolResult> {
  const { count: totalTasks } = await ctx.db
    .from('agent_workforce_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ctx.workspaceId);

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const { count: completedThisWeek } = await ctx.db
    .from('agent_workforce_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ctx.workspaceId)
    .in('status', ['completed', 'approved'])
    .gte('completed_at', weekAgo.toISOString());

  const { count: failedTasks } = await ctx.db
    .from('agent_workforce_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ctx.workspaceId)
    .eq('status', 'failed');

  const { count: agentCount } = await ctx.db
    .from('agent_workforce_agents')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ctx.workspaceId);

  const { count: pendingApprovals } = await ctx.db
    .from('agent_workforce_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ctx.workspaceId)
    .eq('status', 'needs_approval');

  const { count: projectCount } = await ctx.db
    .from('agent_workforce_projects')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ctx.workspaceId);

  const { data: costData } = await ctx.db
    .from('agent_workforce_tasks')
    .select('cost_cents')
    .eq('workspace_id', ctx.workspaceId)
    .not('cost_cents', 'is', null);

  const totalCostCents = ((costData || []) as Array<{ cost_cents: number }>)
    .reduce((sum, t) => sum + (t.cost_cents || 0), 0);

  return {
    success: true,
    data: {
      totalTasks: totalTasks || 0,
      completedThisWeek: completedThisWeek || 0,
      failedTasks: failedTasks || 0,
      pendingApprovals: pendingApprovals || 0,
      totalAgents: agentCount || 0,
      totalProjects: projectCount || 0,
      totalCostCents,
    },
  };
}

export async function getActivityFeed(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const limit = (input.limit as number) || 10;

  const { data, error } = await ctx.db
    .from('agent_workforce_activity')
    .select('id, title, description, activity_type, agent_id, created_at')
    .eq('workspace_id', ctx.workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return { success: false, error: error.message };

  return { success: true, data: data || [] };
}
