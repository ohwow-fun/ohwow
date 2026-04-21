/**
 * CDP Trace Events MCP Tool
 *
 * ohwow_list_cdp_events — query the cdp_trace_events table for browser
 * lifecycle, claim/release, and tab events recorded at every cdp:true
 * log call site.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

interface CdpTraceEventJson {
  id: string;
  workspace_id: string;
  ts: string;
  action: string;
  profile: string | null;
  target_id: string | null;
  owner: string | null;
  url: string | null;
  metadata_json: string | null;
  created_at: string;
}

function errorResponse(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

function jsonResponse(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function registerCdpTraceEventsTools(server: McpServer, client: DaemonApiClient): void {
  server.tool(
    'ohwow_list_cdp_events',
    '[CDP] List Chrome browser lifecycle trace events. Returns cdp:true structured log entries with action, profile, owner, and timestamp. Use for debugging browser automation, detecting claim leaks (claim without matching release), and auditing Chrome tab lifecycle.',
    {
      profile: z
        .string()
        .optional()
        .describe('Filter by Chrome profile directory name (e.g. "Default", "Profile 1").'),
      owner: z
        .string()
        .optional()
        .describe('Filter by claim owner (task id or session id that claimed the tab).'),
      action: z
        .string()
        .optional()
        .describe('Filter by action string (e.g. "claim", "release", "browser:open", "tab:attach", "navigate").'),
      since: z
        .string()
        .optional()
        .describe('ISO 8601 timestamp. Only return events at or after this time.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe('Cap on rows returned. Default 50, hard max 200.'),
    },
    async ({ profile, owner, action, since, limit }) => {
      try {
        const qs = new URLSearchParams();
        if (profile) qs.set('profile', profile);
        if (owner) qs.set('owner', owner);
        if (action) qs.set('action', action);
        if (since) qs.set('since', since);
        if (limit !== undefined) qs.set('limit', String(limit));
        const qsStr = qs.toString() ? `?${qs.toString()}` : '';
        const result = (await client.get(`/api/cdp-trace-events${qsStr}`)) as {
          data?: CdpTraceEventJson[];
          count?: number;
          limit?: number;
          error?: string;
        };
        if (result.error) return errorResponse(`Couldn't list CDP events: ${result.error}`);
        return jsonResponse({ data: result.data ?? [], count: result.count ?? 0, limit: result.limit ?? 50 });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );
}
