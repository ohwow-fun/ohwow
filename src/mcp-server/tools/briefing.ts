/**
 * Daily Briefing MCP Tool
 * AI-generated morning digest combining calendar, pipeline, tasks, contacts, and revenue.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

export function registerBriefingTools(server: McpServer, client: DaemonApiClient): void {
  server.tool(
    'ohwow_daily_briefing',
    '[Briefing] Morning digest combining today\'s calendar, pipeline status, pending tasks, stale leads, and revenue snapshot. The perfect way to start your day.',
    {
      date: z.string().optional().describe('Date for the briefing (ISO format). Defaults to today.'),
    },
    async ({ date }) => {
      try {
        const targetDate = date || new Date().toISOString().split('T')[0];
        const text = await client.postSSE('/api/chat', {
          message: `Generate a daily business briefing for ${targetDate}. Gather and present:

1. **Today's Calendar**: List all events for today with times and attendees.
2. **Pipeline Snapshot**: How many active deals, total pipeline value, any deals expected to close this week.
3. **Pending Tasks**: Tasks that are in progress or overdue.
4. **Stale Leads**: Contacts tagged as leads with no activity in the last 7 days.
5. **Revenue Pulse**: This month's revenue vs. last month. Any new closed-won deals.
6. **Action Items**: Top 3 things to focus on today based on the above.

Use available tools to fetch real data. Format the briefing clearly with sections. Keep it scannable.`,
        }, 60_000);
        return { content: [{ type: 'text' as const, text: text || 'Could not generate briefing. Make sure the process is running and has data.' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
