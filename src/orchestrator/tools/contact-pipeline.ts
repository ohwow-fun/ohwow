/**
 * Contact Pipeline Tool — sales funnel data for the orchestrator.
 * Surfaces lead/customer breakdown, stale leads, and recent activity.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

export async function getContactPipeline(ctx: LocalToolContext): Promise<ToolResult> {
  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const fourteenDaysAgo = new Date(now);
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  // Contact counts by type
  const [
    { count: totalLeads },
    { count: totalCustomers },
    { count: totalPartners },
    { count: totalOther },
    { count: addedLast7d },
    { count: recentEvents },
  ] = await Promise.all([
    ctx.db.from('agent_workforce_contacts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).eq('contact_type', 'lead').eq('status', 'active'),
    ctx.db.from('agent_workforce_contacts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).eq('contact_type', 'customer').eq('status', 'active'),
    ctx.db.from('agent_workforce_contacts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).eq('contact_type', 'partner').eq('status', 'active'),
    ctx.db.from('agent_workforce_contacts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).eq('contact_type', 'other').eq('status', 'active'),
    ctx.db.from('agent_workforce_contacts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).gte('created_at', sevenDaysAgo.toISOString()),
    ctx.db.from('agent_workforce_contact_events').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId).gte('created_at', sevenDaysAgo.toISOString()),
  ]);

  // Stale leads: leads with no contact events in the last 14 days
  // Get all active leads, then check which ones have recent events
  const { data: allLeads } = await ctx.db
    .from('agent_workforce_contacts')
    .select('id, name, company, created_at')
    .eq('workspace_id', ctx.workspaceId)
    .eq('contact_type', 'lead')
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  const leads = (allLeads || []) as Array<{ id: string; name: string; company: string | null; created_at: string }>;

  // Find leads with no events in 14 days
  const staleLeads: Array<{ id: string; name: string; company: string | null }> = [];
  for (const lead of leads) {
    const { count: eventCount } = await ctx.db
      .from('agent_workforce_contact_events')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', lead.id)
      .gte('created_at', fourteenDaysAgo.toISOString());
    if ((eventCount || 0) === 0) {
      staleLeads.push({ id: lead.id, name: lead.name, company: lead.company });
    }
    // Cap at 10 stale leads to keep response manageable
    if (staleLeads.length >= 10) break;
  }

  // Recent activity breakdown by event type
  const { data: recentEventData } = await ctx.db
    .from('agent_workforce_contact_events')
    .select('event_type')
    .eq('workspace_id', ctx.workspaceId)
    .gte('created_at', sevenDaysAgo.toISOString());

  const eventCounts: Record<string, number> = {};
  for (const event of (recentEventData || []) as Array<{ event_type: string }>) {
    eventCounts[event.event_type] = (eventCounts[event.event_type] || 0) + 1;
  }

  return {
    success: true,
    data: {
      breakdown: {
        leads: totalLeads || 0,
        customers: totalCustomers || 0,
        partners: totalPartners || 0,
        other: totalOther || 0,
      },
      addedLast7Days: addedLast7d || 0,
      recentActivityCount: recentEvents || 0,
      recentActivityByType: eventCounts,
      staleLeads: staleLeads,
      staleLeadCount: staleLeads.length,
    },
  };
}
