/**
 * Deal & Pipeline MCP Tools
 * Deal management, pipeline stages, and revenue summaries.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

export function registerDealTools(server: McpServer, client: DaemonApiClient): void {
  server.tool(
    'ohwow_list_deals',
    '[Deals] List deals with stage, value, and close date. Filter by stage, contact, or owner.',
    {
      stage_id: z.string().optional().describe('Filter by pipeline stage ID'),
      contact_id: z.string().optional().describe('Filter by linked contact ID'),
      owner_id: z.string().optional().describe('Filter by deal owner'),
      limit: z.number().optional().describe('Max results (default: 50)'),
    },
    async ({ stage_id, contact_id, owner_id, limit }) => {
      try {
        const params = new URLSearchParams();
        if (stage_id) params.set('stage_id', stage_id);
        if (contact_id) params.set('contact_id', contact_id);
        if (owner_id) params.set('owner_id', owner_id);
        if (limit) params.set('limit', String(limit));
        const query = params.toString();
        const data = await client.get(`/api/deals${query ? `?${query}` : ''}`) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_create_deal',
    '[Deals] Create a new deal in the pipeline. Link it to a contact and set value, stage, and expected close date.',
    {
      title: z.string().describe('Deal title'),
      contact_id: z.string().optional().describe('Linked contact ID'),
      value_cents: z.number().describe('Deal value in cents (e.g. 50000 = $500.00)'),
      stage_id: z.string().optional().describe('Pipeline stage ID (omit for first stage)'),
      expected_close: z.string().optional().describe('Expected close date (ISO format)'),
      owner_id: z.string().optional().describe('Team member who owns the deal'),
      source: z.string().optional().describe('Lead source: website, referral, outbound, etc.'),
      notes: z.string().optional().describe('Notes about the deal'),
    },
    async ({ title, contact_id, value_cents, stage_id, expected_close, owner_id, source, notes }) => {
      try {
        const body: Record<string, unknown> = { title, value_cents };
        if (contact_id) body.contact_id = contact_id;
        if (stage_id) body.stage_id = stage_id;
        if (expected_close) body.expected_close = expected_close;
        if (owner_id) body.owner_id = owner_id;
        if (source) body.source = source;
        if (notes) body.notes = notes;
        const result = await client.post('/api/deals', body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_update_deal',
    '[Deals] Move a deal to a new stage, update its value, expected close date, or add notes. Stage changes are logged automatically.',
    {
      id: z.string().describe('Deal ID'),
      stage_id: z.string().optional().describe('New pipeline stage ID'),
      value_cents: z.number().optional().describe('Updated deal value in cents'),
      expected_close: z.string().optional().describe('Updated expected close date'),
      notes: z.string().optional().describe('Updated notes'),
      lost_reason: z.string().optional().describe('Reason the deal was lost'),
    },
    async ({ id, stage_id, value_cents, expected_close, notes, lost_reason }) => {
      try {
        const body: Record<string, unknown> = {};
        if (stage_id) body.stage_id = stage_id;
        if (value_cents !== undefined) body.value_cents = value_cents;
        if (expected_close) body.expected_close = expected_close;
        if (notes) body.notes = notes;
        if (lost_reason) body.lost_reason = lost_reason;
        const result = await client.patch(`/api/deals/${id}`, body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_pipeline_summary',
    '[Deals] Pipeline overview: deal count and value per stage, weighted forecast, win rate, and average deal size.',
    {},
    async () => {
      try {
        const data = await client.get('/api/deals/pipeline-summary') as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  server.tool(
    'ohwow_revenue_summary',
    '[Revenue] MRR, MRR growth, ARR, monthly revenue trend, and won deal metrics.',
    {
      months: z.number().optional().describe('Lookback months (default: 12)'),
    },
    async ({ months }) => {
      try {
        const params = months ? `?months=${months}` : '';
        const data = await client.get(`/api/deals/revenue-summary${params}`) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data.data || data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
