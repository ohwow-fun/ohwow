/**
 * Dashboard Init Route
 * GET /api/dashboard/init — Returns all data the web dashboard needs in one request.
 * Eliminates the need for multiple parallel Supabase queries from the browser.
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

export function createDashboardRouter(db: DatabaseAdapter): Router {
  const router = Router();

  router.get('/api/dashboard/init', async (req, res) => {
    try {
      const { workspaceId } = req;

      // Run all queries in parallel
      const [
        agentsResult,
        tasksResult,
        activityResult,
        departmentsResult,
        approvalCountResult,
        contactsResult,
        revenueResult,
        teamMembersResult,
        customRoadmapResult,
        workspaceResult,
      ] = await Promise.all([
        db.from('agent_workforce_agents')
          .select('id, name, role, status, department_id, stats')
          .eq('workspace_id', workspaceId)
          .order('name'),
        db.from('agent_workforce_tasks')
          .select('id, title, status, agent_id, created_at, tokens_used, cost_cents, duration_seconds, error_message')
          .eq('workspace_id', workspaceId)
          .order('created_at', { ascending: false })
          .limit(50),
        db.from('agent_workforce_activity')
          .select('id, title, description, activity_type, agent_id, task_id, metadata, created_at')
          .eq('workspace_id', workspaceId)
          .order('created_at', { ascending: false })
          .limit(50),
        db.from('agent_workforce_departments')
          .select('id, name, color, description')
          .eq('workspace_id', workspaceId)
          .order('sort_order'),
        db.from('agent_workforce_tasks')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .eq('status', 'needs_approval'),
        db.from('agent_workforce_contacts')
          .select('*')
          .eq('workspace_id', workspaceId)
          .order('created_at', { ascending: false }),
        db.from('agent_workforce_revenue_entries')
          .select('*')
          .eq('workspace_id', workspaceId)
          .order('year', { ascending: false }),
        db.from('agent_workforce_team_members')
          .select('*')
          .eq('workspace_id', workspaceId)
          .order('created_at', { ascending: false }),
        db.from('agent_workforce_custom_roadmap_stages')
          .select('stage_id, tagline, focus_areas, key_metrics, next_milestone, priority, priority_description, quick_actions, generated_at')
          .eq('workspace_id', workspaceId)
          .order('stage_id'),
        // Get workspace info from runtime_settings (the workspace_id itself is the ID)
        db.from('runtime_settings')
          .select('key, value')
          .eq('key', 'business_name')
          .maybeSingle(),
      ]);

      // Build workspace object from local data
      const businessName = (workspaceResult.data as { value: string } | null)?.value || 'My Workspace';

      res.json({
        data: {
          workspace: {
            id: workspaceId,
            business_name: businessName,
            local_mode: true,
          },
          agents: agentsResult.data || [],
          tasks: tasksResult.data || [],
          activity: activityResult.data || [],
          departments: departmentsResult.data || [],
          pendingApprovalCount: approvalCountResult.count || 0,
          contacts: contactsResult.data || [],
          revenue: revenueResult.data || [],
          teamMembers: teamMembersResult.data || [],
          customRoadmap: customRoadmapResult.data || [],
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
