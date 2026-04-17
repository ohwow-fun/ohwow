/**
 * X DM Drafts MCP Tool
 *
 * One verb, `ohwow_draft_x_dm`, that stages an outbound X DM for the
 * founder to review in the existing approvals queue. Thin wrapper over
 * POST /api/x-dm-drafts, which creates the task+deliverable pair. Once
 * drafted, the row shows up in ohwow_list_approvals and the founder
 * approves/rejects it with ohwow_approve_task / ohwow_reject_task like
 * any other needs_approval task.
 *
 * Design note: we deliberately did NOT mirror the x_post_drafts table +
 * dedicated approve/reject verbs. DM drafts ride the unified approvals
 * pipeline so the founder has one queue for sign-offs, not two.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

interface DraftDmResponse {
  data?: {
    task_id: string;
    contact_id: string;
    handle: string;
    status: string;
    note?: string;
  };
  error?: string;
}

function errorResponse(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function jsonResponse(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

export function registerXDmDraftTools(server: McpServer, client: DaemonApiClient): void {
  server.tool(
    'ohwow_draft_x_dm',
    "[Outreach] Stage an outbound X DM for founder approval. Creates a needs_approval task + a send_dm deliverable attached to the given contact; the draft then appears in ohwow_list_approvals and the founder fires or rejects it with ohwow_approve_task / ohwow_reject_task. The contact must already carry an `x_handle` in `custom_fields` (use ohwow_get_contact to verify). This is the ONLY sanctioned path for agents to queue an outbound DM — never DM a contact directly without sign-off. Dry-run is on by default at execution time; the founder flips `runtime_settings.deliverable_executor_live='true'` to actually send.",
    {
      contact_id: z
        .string()
        .min(1)
        .describe('Target contact id (from ohwow_list_contacts / ohwow_get_contact). Must be in the focused workspace and have custom_fields.x_handle set.'),
      body: z
        .string()
        .min(1)
        .describe('The DM body to send, verbatim. Keep short and conversational. Do NOT pitch a product, do NOT quote the contact\'s own pain back at them, and do NOT open with a hard ask — trust compounds slowly and breaks instantly.'),
      agent_id: z
        .string()
        .optional()
        .describe('Override which agent owns the draft. Defaults to the "Public Communications" (The Voice) agent if present, else the first available agent in the workspace.'),
    },
    async ({ contact_id, body, agent_id }) => {
      try {
        const payload: Record<string, unknown> = { contact_id, body };
        if (agent_id) payload.agent_id = agent_id;
        const result = (await client.post('/api/x-dm-drafts', payload)) as DraftDmResponse;
        if (result.error) return errorResponse(`Couldn't draft DM: ${result.error}`);
        if (!result.data) return errorResponse('Draft response missing data.');
        return jsonResponse({ ok: true, ...result.data });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );
}
