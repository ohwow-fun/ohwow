/**
 * Bookkeeping & Time Tracking MCP Tools
 * Expenses, P&L, team management, and time tracking.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

export function registerBookkeepingTools(server: McpServer, client: DaemonApiClient): void {
  server.tool(
    'ohwow_list_expenses',
    '[Finance] List business expenses with category, amount, vendor, and date.',
    {
      category_id: z.string().optional().describe('Filter by expense category ID'),
      after: z.string().optional().describe('Only expenses after this date (ISO)'),
      before: z.string().optional().describe('Only expenses before this date (ISO)'),
      limit: z.number().optional().describe('Max results (default: 50)'),
    },
    async ({ category_id, after, before, limit }) => {
      try {
        const params = new URLSearchParams();
        if (category_id) params.set('category_id', category_id);
        if (after) params.set('after', after);
        if (before) params.set('before', before);
        if (limit) params.set('limit', String(limit));
        const query = params.toString();
        const data = await client.get(`/api/expenses${query ? `?${query}` : ''}`) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_log_expense',
    '[Finance] Log a business expense with amount, date, category, and vendor.',
    {
      description: z.string().describe('What the expense was for'),
      amount_cents: z.number().describe('Amount in cents (e.g. 9900 = $99.00)'),
      expense_date: z.string().describe('Date of expense (ISO format)'),
      category_id: z.string().optional().describe('Expense category ID'),
      vendor: z.string().optional().describe('Vendor or merchant name'),
      tax_deductible: z.boolean().optional().describe('Whether this expense is tax deductible'),
      is_recurring: z.boolean().optional().describe('Whether this is a recurring expense'),
    },
    async ({ description, amount_cents, expense_date, category_id, vendor, tax_deductible, is_recurring }) => {
      try {
        const body: Record<string, unknown> = { description, amount_cents, expense_date };
        if (category_id) body.category_id = category_id;
        if (vendor) body.vendor = vendor;
        if (tax_deductible !== undefined) body.tax_deductible = tax_deductible;
        if (is_recurring !== undefined) body.is_recurring = is_recurring;
        const result = await client.post('/api/expenses', body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_financial_summary',
    '[Finance] P&L summary: total revenue, total expenses, net income, and expense breakdown by category.',
    {
      period_start: z.string().optional().describe('Start of period (ISO date). Defaults to first of current month.'),
      period_end: z.string().optional().describe('End of period (ISO date). Defaults to today.'),
    },
    async ({ period_start, period_end }) => {
      try {
        const params = new URLSearchParams();
        if (period_start) params.set('period_start', period_start);
        if (period_end) params.set('period_end', period_end);
        const query = params.toString();
        const data = await client.get(`/api/expenses/summary${query ? `?${query}` : ''}`) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_list_team',
    '[Team] List team members with name, role, and department.',
    {},
    async () => {
      try {
        const data = await client.get('/api/team-members') as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_track_time',
    '[Time] Log a time entry for a team member on a project, deal, or ticket.',
    {
      team_member_id: z.string().describe('Team member ID'),
      duration_minutes: z.number().describe('Duration in minutes'),
      entry_date: z.string().describe('Date of work (ISO format)'),
      project_id: z.string().optional().describe('Project ID'),
      deal_id: z.string().optional().describe('Deal ID'),
      ticket_id: z.string().optional().describe('Support ticket ID'),
      description: z.string().optional().describe('What was worked on'),
      billable: z.boolean().optional().describe('Whether this time is billable (default: true)'),
    },
    async ({ team_member_id, duration_minutes, entry_date, project_id, deal_id, ticket_id, description, billable }) => {
      try {
        const body: Record<string, unknown> = { team_member_id, duration_minutes, entry_date };
        if (project_id) body.project_id = project_id;
        if (deal_id) body.deal_id = deal_id;
        if (ticket_id) body.ticket_id = ticket_id;
        if (description) body.description = description;
        if (billable !== undefined) body.billable = billable;
        const result = await client.post('/api/time-entries', body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_time_report',
    '[Time] Time tracking report grouped by person, project, or date. Shows total hours, billable hours, and entry counts.',
    {
      group_by: z.enum(['person', 'project', 'date']).optional().describe('How to group results (default: person)'),
      after: z.string().optional().describe('Only entries after this date (ISO)'),
      before: z.string().optional().describe('Only entries before this date (ISO)'),
      team_member_id: z.string().optional().describe('Filter by team member'),
      project_id: z.string().optional().describe('Filter by project'),
    },
    async ({ group_by, after, before, team_member_id, project_id }) => {
      try {
        const params = new URLSearchParams();
        if (group_by) params.set('group_by', group_by);
        if (after) params.set('after', after);
        if (before) params.set('before', before);
        if (team_member_id) params.set('team_member_id', team_member_id);
        if (project_id) params.set('project_id', project_id);
        const query = params.toString();
        const data = await client.get(`/api/time-entries/report${query ? `?${query}` : ''}`) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
