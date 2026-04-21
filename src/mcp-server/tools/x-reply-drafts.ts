/**
 * X / Threads Reply Drafts MCP tools
 *
 * ohwow_list_x_reply_drafts — list reply drafts (optionally filtered).
 * ohwow_approve_x_reply_draft(id) — flip status to 'approved'. Dispatcher
 *   will pick it up on its next tick and post.
 * ohwow_reject_x_reply_draft(id) — flip status to 'rejected'.
 *
 * Reply drafts are created by the X / Threads reply schedulers from the
 * pain-finder pipeline (pain-oriented queries + pain-vs-seller classifier
 * + two-mode drafter). Operator reviews them here before anything is
 * posted.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

interface ReplyDraftJson {
  id: string;
  workspace_id: string;
  platform: 'x' | 'threads';
  reply_to_url: string;
  reply_to_author: string | null;
  reply_to_text: string | null;
  reply_to_likes: number | null;
  reply_to_replies: number | null;
  mode: 'direct' | 'viral';
  body: string;
  alternates_json: string | null;
  verdict_json: string | null;
  score: number | null;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'auto_applied';
  created_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  applied_at: string | null;
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

export function registerXReplyDraftTools(server: McpServer, client: DaemonApiClient): void {
  server.tool(
    'ohwow_list_x_reply_drafts',
    "[Reply pipeline] List candidate X/Threads reply drafts the process has queued from the pain-finder pipeline. Each draft contains the target post (reply_to_url + author + text + engagement), the drafted reply body, alternates, the classifier verdict (class, pain_domain, severity, sellerish), and a score. Modes: 'direct' (1:1 reply to a real operator, genuine_pain or solo_service_provider class) and 'viral' (broadcast reply into a crowded ICP-packed thread). Rows are 'pending' until you approve or reject; once approved, the reply dispatcher picks them up on its next tick (~5 min).",
    {
      platform: z
        .enum(['x', 'threads'])
        .optional()
        .describe("Filter by platform. Default returns both."),
      status: z
        .enum(['pending', 'approved', 'rejected', 'applied', 'auto_applied'])
        .optional()
        .describe("Filter by status. 'pending' = awaiting review; 'approved' = queued for dispatch; 'applied' = already posted; 'auto_applied' = posted without approval gate; 'rejected' = skipped."),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe('Cap on rows returned. Default 50, hard max 200.'),
    },
    async ({ platform, status, limit }) => {
      try {
        const qs = new URLSearchParams();
        if (platform) qs.set('platform', platform);
        if (status) qs.set('status', status);
        if (limit !== undefined) qs.set('limit', String(limit));
        const qsStr = qs.toString() ? `?${qs.toString()}` : '';
        const result = (await client.get(`/api/x-reply-drafts${qsStr}`)) as {
          data?: ReplyDraftJson[];
          count?: number;
          limit?: number;
          error?: string;
        };
        if (result.error) return errorResponse(`Couldn't list reply drafts: ${result.error}`);
        const drafts = result.data ?? [];
        return jsonResponse({
          ok: true,
          count: drafts.length,
          limit: result.limit,
          drafts,
          note:
            drafts.length === 0
              ? 'X reply drafts are permanently disabled. The X account is banned. Only Threads reply drafts are produced.'
              : `${drafts.length} draft(s). Approve with ohwow_approve_x_reply_draft, reject with ohwow_reject_x_reply_draft. Dispatcher ticks ~5 min after approval.`,
        });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );

  server.tool(
    'ohwow_approve_x_reply_draft',
    "[Reply pipeline] Approve a reply draft. Flips status to 'approved' and stamps approved_at. The reply dispatcher (5-min tick) picks up approved rows, takes the CDP lane, calls the platform's compose_reply executor, and stamps 'applied' on success. Daily cap (x_reply.daily_cap / threads_reply.daily_cap, default 10) is enforced at dispatch time.",
    {
      id: z
        .string()
        .min(1)
        .describe('The draft row id from ohwow_list_x_reply_drafts.'),
    },
    async ({ id }) => {
      try {
        const result = (await client.post(`/api/x-reply-drafts/${encodeURIComponent(id)}/approve`, {})) as {
          data?: ReplyDraftJson;
          error?: string;
        };
        if (result.error) return errorResponse(`Couldn't approve draft: ${result.error}`);
        if (!result.data) return errorResponse('Draft not found.');
        return jsonResponse({ ok: true, draft: result.data });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );

  server.tool(
    'ohwow_reject_x_reply_draft',
    "[Reply pipeline] Reject a reply draft. Flips status to 'rejected' and stamps rejected_at. Rejected drafts are skipped by the dispatcher and remain in the table for audit.",
    {
      id: z
        .string()
        .min(1)
        .describe('The draft row id from ohwow_list_x_reply_drafts.'),
    },
    async ({ id }) => {
      try {
        const result = (await client.post(`/api/x-reply-drafts/${encodeURIComponent(id)}/reject`, {})) as {
          data?: ReplyDraftJson;
          error?: string;
        };
        if (result.error) return errorResponse(`Couldn't reject draft: ${result.error}`);
        if (!result.data) return errorResponse('Draft not found.');
        return jsonResponse({ ok: true, draft: result.data });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );
}
