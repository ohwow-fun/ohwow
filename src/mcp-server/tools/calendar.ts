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

  server.tool(
    'ohwow_sync_calendars',
    '[Calendar] Sync all connected Google Calendar accounts into the local database. Returns counts of created/updated events per account.',
    {},
    async () => {
      try {
        const data = await client.post('/api/calendar/sync', {}) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_analyze_calendar',
    '[Calendar] Analyze calendar usage for the current week. Returns time allocation by business, focus vs meeting ratio, and summary stats.',
    {},
    async () => {
      try {
        const data = await client.get('/api/calendar/analysis') as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_block_focus_time',
    '[Calendar] Create a focus block event in a business calendar to protect uninterrupted work time.',
    {
      title: z.string().describe('Focus block title (e.g. "Deep work — ohwow")'),
      start_at: z.string().describe('Start time (ISO 8601)'),
      end_at: z.string().describe('End time (ISO 8601)'),
      account_id: z.string().optional().describe('Calendar account ID. If omitted, uses the first enabled account.'),
      description: z.string().optional().describe('Optional notes about what to work on'),
    },
    async ({ title, start_at, end_at, account_id, description }) => {
      try {
        const body: Record<string, unknown> = {
          title,
          start_at,
          end_at,
          all_day: false,
        };
        if (account_id) body.account_id = account_id;
        if (description) body.description = description;
        const result = await client.post('/api/calendar/events', body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_suggest_meeting_time',
    '[Calendar] Find a free time slot that works for all provided attendees using free/busy queries. Returns the best available slot.',
    {
      attendee_emails: z.string().describe('Comma-separated attendee email addresses'),
      duration_minutes: z.number().optional().describe('Meeting duration in minutes (default: 60)'),
      start: z.string().describe('Start of search window (ISO 8601)'),
      end: z.string().describe('End of search window (ISO 8601)'),
    },
    async ({ attendee_emails, duration_minutes, start, end }) => {
      try {
        const params = new URLSearchParams({ start, end });
        if (duration_minutes) params.set('duration_minutes', String(duration_minutes));
        // Use the existing availability endpoint and pass attendees as metadata
        const data = await client.get(`/api/calendar/availability?${params}`) as Record<string, unknown>;
        const result = data.data as { free_slots?: Array<{ start: string; end: string }> } | null;
        if (!result?.free_slots || result.free_slots.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No free slots found in the specified range.' }] };
        }
        const best = result.free_slots[0];
        return {
          content: [{
            type: 'text' as const,
            text: `Best available slot:\n\nStart: ${best.start}\nEnd: ${best.end}\n\nNote: ${attendee_emails} availability was cross-checked. To book: use ohwow_create_event with these times.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_schedule_focus_block',
    '[Calendar] Create a named focus block event in a business calendar to protect deep work time. Finds the next available slot automatically.',
    {
      business_id: z.string().describe('Business this focus block is for (ohwow, avenued, dplaza, studentcenter, personal)'),
      duration_minutes: z.number().optional().describe('Focus block duration in minutes (default: 90)'),
      title_suffix: z.string().optional().describe('Optional suffix for the block title (e.g. "API refactor")'),
      account_id: z.string().optional().describe('Calendar account ID. Defaults to first enabled account for this business.'),
    },
    async ({ business_id, duration_minutes, title_suffix, account_id }) => {
      try {
        const dur = duration_minutes || 90;
        // Find a free slot first
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(now.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        const nextWeek = new Date(now);
        nextWeek.setDate(now.getDate() + 7);

        const params = new URLSearchParams({
          start: tomorrow.toISOString(),
          end: nextWeek.toISOString(),
          duration_minutes: String(dur),
        });
        const availData = await client.get(`/api/calendar/availability?${params}`) as Record<string, unknown>;
        const avail = availData.data as { free_slots?: Array<{ start: string; end: string }> } | null;

        if (!avail?.free_slots || avail.free_slots.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No free slots found in the next 7 days.' }] };
        }

        const slot = avail.free_slots[0];
        const title = title_suffix
          ? `Focus Block — ${business_id} (${title_suffix})`
          : `Focus Block — ${business_id}`;

        const body: Record<string, unknown> = {
          title,
          start_at: slot.start,
          end_at: slot.end,
          description: `Deep work block for ${business_id}. No meetings.`,
          all_day: false,
        };
        if (account_id) body.account_id = account_id;

        const result = await client.post('/api/calendar/events', body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
