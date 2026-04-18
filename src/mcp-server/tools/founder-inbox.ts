/**
 * Founder Inbox MCP Tools (autonomy arc Phase 4).
 *
 * Two surfaces over the daemon-local `founder_inbox` table:
 *   * `ohwow_list_founder_inbox` — list outstanding (or filtered) rows
 *     so the founder can decide which to answer.
 *   * `ohwow_answer_founder_inbox` — record an answer; the Director's
 *     next tick flips the row to `resolved` and feeds the answer back
 *     to the picker.
 *
 * Distinction from `ohwow_list_approvals` (cloud approvals): these are
 * *process* decisions raised mid-phase (should this scope keep going,
 * is this the right fork). Product/copy approvals stay on the existing
 * approval flow.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

const FOUNDER_INBOX_STATUSES = ['open', 'answered', 'resolved', 'expired'] as const;
type FounderInboxStatus = (typeof FOUNDER_INBOX_STATUSES)[number];

interface FounderInboxRow {
  id: string;
  workspace_id: string;
  arc_id: string | null;
  phase_id: string | null;
  mode: string;
  blocker: string;
  context: string;
  options: Array<{ label: string; text: string }>;
  recommended: string | null;
  screenshot_path: string | null;
  asked_at: string;
  answered_at: string | null;
  answer: string | null;
  status: FounderInboxStatus;
}

function jsonResponse(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResponse(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

export function registerFounderInboxTools(
  server: McpServer,
  client: DaemonApiClient,
): void {
  server.tool(
    'ohwow_list_founder_inbox',
    '[Director] List founder-inbox questions raised by the autonomy Director. These are *process* decisions (should this phase keep going, is this scope right) the runtime cannot resolve on its own. Defaults to status="open" — pass "answered" to see your replies that the Director has not yet picked up, "resolved" to see closed ones. Each row carries the originating arc/phase, the blocker (one sentence), longer context, options the Director considered, an optional recommended choice, and the timestamp the question was raised.',
    {
      status: z
        .enum(FOUNDER_INBOX_STATUSES)
        .optional()
        .describe('Filter by inbox status. Defaults to "open".'),
    },
    async ({ status }) => {
      try {
        const qs = status ? `?status=${encodeURIComponent(status)}` : '';
        const result = (await client.get(`/api/founder-inbox${qs}`)) as {
          data?: FounderInboxRow[];
          error?: string;
        };
        if (result.error) {
          return errorResponse(`Couldn't list founder inbox: ${result.error}`);
        }
        const rows = result.data ?? [];
        return jsonResponse({
          ok: true,
          count: rows.length,
          status: status ?? 'open',
          inbox: rows.map((r) => ({
            id: r.id,
            asked_at: r.asked_at,
            mode: r.mode,
            blocker: r.blocker,
            context: r.context,
            options: r.options,
            recommended: r.recommended,
            arc_id: r.arc_id,
            phase_id: r.phase_id,
            status: r.status,
            answer: r.answer,
            answered_at: r.answered_at,
          })),
          note:
            rows.length === 0
              ? 'No founder-inbox rows match. The Director is unblocked.'
              : `${rows.length} row(s). Answer via ohwow_answer_founder_inbox.`,
        });
      } catch (err) {
        return errorResponse(
          `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
      }
    },
  );

  server.tool(
    'ohwow_answer_founder_inbox',
    '[Director] Answer a founder-inbox question by id. Pass the inbox row id and your answer text. The Director picks up the answer on its next tick, flips the row to "resolved", and feeds the text back into the next phase plan brief.',
    {
      id: z
        .string()
        .min(1)
        .describe('The inbox row id from ohwow_list_founder_inbox.'),
      answer: z
        .string()
        .min(1)
        .describe(
          'Your answer text. Be concrete; this is spliced into the next plan brief verbatim.',
        ),
    },
    async ({ id, answer }) => {
      try {
        const result = (await client.post(
          `/api/founder-inbox/${encodeURIComponent(id)}/answer`,
          { answer },
        )) as { ok?: boolean; error?: string };
        if (result.error) {
          return errorResponse(
            `Couldn't answer founder inbox row ${id}: ${result.error}`,
          );
        }
        return jsonResponse({ ok: true, id });
      } catch (err) {
        return errorResponse(
          `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
      }
    },
  );
}
