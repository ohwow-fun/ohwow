/**
 * Daily Reps Status Tool — tracks today's activity vs recommended minimums.
 * Helps the orchestrator give specific, actionable nudges.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

// Hardcoded daily minimums — can be extracted to workspace config later
const DAILY_MINIMUMS = {
  tasksCompleted: 3,
  contactTouchpoints: 2,
  approvalsProcessed: 2,
};

export async function getDailyRepsStatus(ctx: LocalToolContext): Promise<ToolResult> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const [
    { count: tasksCompleted },
    { count: contactTouchpoints },
    { count: approvalsProcessed },
    { count: tasksFailed },
    { count: tasksRunning },
    { count: pendingApprovals },
  ] = await Promise.all([
    // Tasks completed today
    ctx.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).in('status', ['completed', 'approved'])
      .gte('completed_at', todayStart.toISOString()),
    // Contact events today (touchpoints)
    ctx.db.from('agent_workforce_contact_events').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).gte('created_at', todayStart.toISOString()),
    // Approvals processed today (approved or rejected)
    ctx.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).in('status', ['approved'])
      .gte('completed_at', todayStart.toISOString()),
    // Tasks failed today
    ctx.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).eq('status', 'failed')
      .gte('created_at', todayStart.toISOString()),
    // Currently running
    ctx.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).eq('status', 'running'),
    // Pending approvals
    ctx.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).eq('status', 'needs_approval'),
  ]);

  const completed = tasksCompleted || 0;
  const touchpoints = contactTouchpoints || 0;
  const approvals = approvalsProcessed || 0;

  // Calculate completion rate against minimums
  const reps = [
    { name: 'Tasks completed', actual: completed, target: DAILY_MINIMUMS.tasksCompleted },
    { name: 'Contact touchpoints', actual: touchpoints, target: DAILY_MINIMUMS.contactTouchpoints },
    { name: 'Approvals processed', actual: approvals, target: DAILY_MINIMUMS.approvalsProcessed },
  ];

  const totalActual = reps.reduce((sum, r) => sum + Math.min(r.actual, r.target), 0);
  const totalTarget = reps.reduce((sum, r) => sum + r.target, 0);
  const completionRate = totalTarget > 0 ? Math.round((totalActual / totalTarget) * 100) : 0;

  // Compute streak (consecutive days with at least 1 completed task)
  let streakDays = 0;
  const checkDate = new Date(todayStart);
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
      streakDays++;
    } else {
      break;
    }
  }

  return {
    success: true,
    data: {
      reps,
      completionRate,
      streakDays,
      todaySummary: {
        tasksCompleted: completed,
        contactTouchpoints: touchpoints,
        approvalsProcessed: approvals,
        tasksFailed: tasksFailed || 0,
        tasksRunning: tasksRunning || 0,
        pendingApprovals: pendingApprovals || 0,
      },
    },
  };
}
