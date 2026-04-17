/**
 * Support Ticket & Analytics MCP Tools
 * Ticket management, metrics, website analytics, and business reports.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

export function registerTicketTools(server: McpServer, client: DaemonApiClient): void {
  server.tool(
    'ohwow_list_tickets',
    '[Support] List support tickets with status, priority, and assignee. Filter by status, priority, contact, or assignee.',
    {
      status: z.enum(['open', 'in_progress', 'waiting', 'resolved', 'closed']).optional().describe('Filter by ticket status'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Filter by priority'),
      assignee_id: z.string().optional().describe('Filter by assignee'),
      contact_id: z.string().optional().describe('Filter by linked contact'),
      limit: z.number().optional().describe('Max results (default: 50)'),
    },
    async ({ status, priority, assignee_id, contact_id, limit }) => {
      try {
        const params = new URLSearchParams();
        if (status) params.set('status', status);
        if (priority) params.set('priority', priority);
        if (assignee_id) params.set('assignee_id', assignee_id);
        if (contact_id) params.set('contact_id', contact_id);
        if (limit) params.set('limit', String(limit));
        const query = params.toString();
        const data = await client.get(`/api/tickets${query ? `?${query}` : ''}`) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_create_ticket',
    '[Support] Create a support ticket. Optionally link to a contact and assign to a team member.',
    {
      subject: z.string().describe('Ticket subject'),
      description: z.string().optional().describe('Detailed description of the issue'),
      contact_id: z.string().optional().describe('Linked customer contact ID'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Ticket priority (default: normal)'),
      category: z.string().optional().describe('Category: billing, technical, general, feature_request'),
      assignee_id: z.string().optional().describe('Team member to assign'),
    },
    async ({ subject, description, contact_id, priority, category, assignee_id }) => {
      try {
        const body: Record<string, unknown> = { subject };
        if (description) body.description = description;
        if (contact_id) body.contact_id = contact_id;
        if (priority) body.priority = priority;
        if (category) body.category = category;
        if (assignee_id) body.assignee_id = assignee_id;
        const result = await client.post('/api/tickets', body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_update_ticket',
    '[Support] Update a ticket: change status, priority, assignee, or add an internal note. Status changes auto-track response and resolution times.',
    {
      id: z.string().describe('Ticket ID'),
      status: z.enum(['open', 'in_progress', 'waiting', 'resolved', 'closed']).optional().describe('New status'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('New priority'),
      assignee_id: z.string().optional().describe('New assignee'),
      note: z.string().optional().describe('Internal note to add (visible only to team)'),
    },
    async ({ id, status, priority, assignee_id, note }) => {
      try {
        // Update ticket fields
        const updates: Record<string, unknown> = {};
        if (status) updates.status = status;
        if (priority) updates.priority = priority;
        if (assignee_id) updates.assignee_id = assignee_id;

        let ticketResult: unknown = null;
        if (Object.keys(updates).length > 0) {
          ticketResult = await client.patch(`/api/tickets/${id}`, updates);
        }

        // Add internal note if provided
        let noteResult: unknown = null;
        if (note) {
          noteResult = await client.post(`/api/tickets/${id}/comments`, {
            body: note,
            is_internal: true,
            author_name: 'System',
          });
        }

        const result = ticketResult || noteResult || { data: { ok: true } };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_ticket_metrics',
    '[Support] Support metrics: average response time, resolution time, SLA compliance, volume by category and priority.',
    {
      days: z.number().optional().describe('Lookback period in days (default: 30)'),
    },
    async ({ days }) => {
      try {
        const params = days ? `?days=${days}` : '';
        const data = await client.get(`/api/tickets/metrics${params}`) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_website_analytics',
    '[Analytics] Website traffic, top pages, and referrers from the latest analytics snapshot.',
    {
      period_start: z.string().optional().describe('Start of period (ISO date)'),
      period_end: z.string().optional().describe('End of period (ISO date)'),
    },
    async ({ period_start, period_end }) => {
      try {
        const params = new URLSearchParams();
        if (period_start) params.set('period_start', period_start);
        if (period_end) params.set('period_end', period_end);
        const query = params.toString();
        const endpoint = query ? `/api/analytics?${query}` : '/api/analytics/summary';
        const data = await client.get(endpoint) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_business_report',
    '[Reports] AI-generated weekly business report combining revenue, pipeline, contacts, tasks, and support metrics.',
    {
      weeks: z.number().optional().describe('Lookback period in weeks (default: 1)'),
    },
    async ({ weeks }) => {
      try {
        const lookback = weeks || 1;
        const text = await client.postSSE('/api/chat', {
          message: `Generate a business report for the last ${lookback} week${lookback > 1 ? 's' : ''}. Include:

1. **Revenue**: Total revenue, MRR trend, new closed-won deals.
2. **Pipeline**: Active deals, total pipeline value, deals advancing or stalling.
3. **Contacts**: New contacts added, leads in each stage, stale leads.
4. **Tasks**: Completed vs. created, overdue items.
5. **Support**: Open tickets, avg resolution time, any SLA breaches.
6. **Highlights**: Top 3 wins and top 3 risks.

Use available tools to fetch real data. Format clearly with sections and numbers.`,
        }, 60_000);
        return { content: [{ type: 'text' as const, text: text || 'Could not generate report.' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
