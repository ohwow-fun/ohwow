/**
 * Business Pulse Tool — deep analytics snapshot for the orchestrator.
 * Goes beyond the embedded pulse with weekly/monthly trends, agent utilization, and streaks.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

export async function getBusinessPulse(ctx: LocalToolContext): Promise<ToolResult> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [
    { count: tasksToday },
    { count: tasksThisWeek },
    { count: tasksThisMonth },
    { count: failedTasks30d },
    { count: contactsTotal },
    { count: contactsLeads },
    { count: contactsCustomers },
    { count: contactsAddedThisWeek },
    { data: agentData },
    { count: schedulesRanToday },
  ] = await Promise.all([
    // Tasks today
    ctx.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).in('status', ['completed', 'approved'])
      .gte('completed_at', todayStart.toISOString()),
    // Tasks this week
    ctx.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).in('status', ['completed', 'approved'])
      .gte('completed_at', weekAgo.toISOString()),
    // Tasks this month
    ctx.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).in('status', ['completed', 'approved'])
      .gte('completed_at', thirtyDaysAgo.toISOString()),
    // Failed tasks (30d)
    ctx.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).eq('status', 'failed')
      .gte('created_at', thirtyDaysAgo.toISOString()),
    // Contact counts
    ctx.db.from('agent_workforce_contacts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).eq('status', 'active'),
    ctx.db.from('agent_workforce_contacts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).eq('contact_type', 'lead').eq('status', 'active'),
    ctx.db.from('agent_workforce_contacts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).eq('contact_type', 'customer').eq('status', 'active'),
    ctx.db.from('agent_workforce_contacts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).gte('created_at', weekAgo.toISOString()),
    // Agents
    ctx.db.from('agent_workforce_agents').select('id, status')
      .eq('workspace_id', ctx.workspaceId),
    // Schedules that fired today
    ctx.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).eq('trigger', 'schedule')
      .gte('created_at', todayStart.toISOString()),
  ]);

  // Revenue comparison: current month vs previous month
  const [
    { data: currentRevenue },
    { data: prevRevenue },
  ] = await Promise.all([
    ctx.db.from('agent_workforce_revenue_entries').select('amount_cents')
      .eq('workspace_id', ctx.workspaceId)
      .gte('created_at', monthStart.toISOString()),
    ctx.db.from('agent_workforce_revenue_entries').select('amount_cents')
      .eq('workspace_id', ctx.workspaceId)
      .gte('created_at', prevMonthStart.toISOString())
      .lt('created_at', monthStart.toISOString()),
  ]);

  const currentRevenueCents = ((currentRevenue || []) as Array<{ amount_cents: number }>)
    .reduce((sum, r) => sum + (r.amount_cents || 0), 0);
  const prevRevenueCents = ((prevRevenue || []) as Array<{ amount_cents: number }>)
    .reduce((sum, r) => sum + (r.amount_cents || 0), 0);

  // Agent status breakdown
  const agents = (agentData || []) as Array<{ id: string; status: string }>;
  const agentsByStatus = {
    active: agents.filter((a) => a.status === 'working').length,
    idle: agents.filter((a) => a.status === 'idle').length,
    paused: agents.filter((a) => a.status === 'paused').length,
    total: agents.length,
  };

  // Compute consecutive days streak (days with at least 1 completed task)
  let streak = 0;
  const checkDate = new Date(todayStart);
  // Check up to 30 days back for streak
  for (let i = 0; i < 30; i++) {
    const dayEnd = new Date(checkDate);
    checkDate.setDate(checkDate.getDate() - 1);
    const { count } = await ctx.db
      .from('agent_workforce_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId)
      .in('status', ['completed', 'approved'])
      .gte('completed_at', checkDate.toISOString())
      .lt('completed_at', dayEnd.toISOString());
    if ((count || 0) > 0) {
      streak++;
    } else {
      break;
    }
  }

  return {
    success: true,
    data: {
      tasks: {
        today: tasksToday || 0,
        thisWeek: tasksThisWeek || 0,
        last30Days: tasksThisMonth || 0,
        failed30d: failedTasks30d || 0,
      },
      contacts: {
        total: contactsTotal || 0,
        leads: contactsLeads || 0,
        customers: contactsCustomers || 0,
        addedThisWeek: contactsAddedThisWeek || 0,
      },
      revenue: {
        currentMonthCents: currentRevenueCents,
        previousMonthCents: prevRevenueCents,
      },
      agents: agentsByStatus,
      schedulesRanToday: schedulesRanToday || 0,
      streakDays: streak,
    },
  };
}
