/**
 * Calendar MCP Tools
 * Event management and availability queries.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

export function registerCalendarTools(server: McpServer, client: DaemonApiClient): void {
  server.tool(
    'ohwow_list_events',
    '[Calendar] List calendar events for a date range. Returns title, time, location, attendees, and status.',
    {
      start: z.string().describe('Start of range (ISO date or datetime)'),
      end: z.string().optional().describe('End of range (ISO date or datetime). Defaults to end of start date.'),
      account_id: z.string().optional().describe('Filter by calendar account ID'),
      limit: z.number().optional().describe('Max results (default: 50)'),
    },
    async ({ start, end, account_id, limit }) => {
      try {
        const params = new URLSearchParams();
        params.set('start', start);
        if (end) params.set('end', end);
        if (account_id) params.set('account_id', account_id);
        if (limit) params.set('limit', String(limit));
        const data = await client.get(`/api/calendar/events?${params}`) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_create_event',
    '[Calendar] Create a calendar event with title, time, location, and attendees.',
    {
      title: z.string().describe('Event title'),
      start_at: z.string().describe('Start time (ISO 8601)'),
      end_at: z.string().describe('End time (ISO 8601)'),
      description: z.string().optional().describe('Event description'),
      location: z.string().optional().describe('Event location'),
      attendees: z.array(z.object({
        email: z.string(),
        name: z.string().optional(),
      })).optional().describe('List of attendees'),
      all_day: z.boolean().optional().describe('Whether this is an all-day event'),
      account_id: z.string().optional().describe('Calendar account ID'),
    },
    async ({ title, start_at, end_at, description, location, attendees, all_day, account_id }) => {
      try {
        const body: Record<string, unknown> = { title, start_at, end_at };
        if (description) body.description = description;
        if (location) body.location = location;
        if (attendees) body.attendees = attendees;
        if (all_day !== undefined) body.all_day = all_day;
        if (account_id) body.account_id = account_id;
        const result = await client.post('/api/calendar/events', body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_find_availability',
    '[Calendar] Find free time slots across calendars. Returns available slots during business hours (9am-5pm, weekdays).',
    {
      start: z.string().describe('Start of search range (ISO date or datetime)'),
      end: z.string().describe('End of search range (ISO date or datetime)'),
      duration_minutes: z.number().optional().describe('Slot duration in minutes (default: 30)'),
    },
    async ({ start, end, duration_minutes }) => {
      try {
        const params = new URLSearchParams();
        params.set('start', start);
        params.set('end', end);
        if (duration_minutes) params.set('duration_minutes', String(duration_minutes));
        const data = await client.get(`/api/calendar/availability?${params}`) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
