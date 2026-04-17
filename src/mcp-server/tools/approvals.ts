/**
 * Approvals MCP Tools
 *
 * The operator-facing approval queue. Tasks in status=needs_approval are
 * agent output waiting for a human decision before the daemon acts on it
 * (posting, sending, delivering). This is the non-permission lane —
 * permission-denied tasks also carry needs_approval status, but those
 * should be resolved via ohwow_approve_permission_request instead, which
 * handles the resume + child-task logic.
 *
 * Thin wrappers around /api/approvals — same endpoints the web Approvals
 * screen calls.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

interface ApprovalTaskRow {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  title: string | null;
  description: string | null;
  status: string;
  output: unknown;
  created_at: string;
  updated_at: string;
  approval_reason: string | null;
  permission_request: unknown;
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

export function registerApprovalTools(server: McpServer, client: DaemonApiClient): void {
  server.tool(
    'ohwow_list_approvals',
    "[Approvals] List every task in status=needs_approval for the focused workspace. Returns title, agent id, status, and the task's output payload so the operator can read what's waiting for sign-off. This is the wider queue that the web Approvals screen shows. Permission-denied tasks also appear here (their approval_reason will be 'permission_denied') but resolve those with ohwow_approve_permission_request, not the generic approve/reject tools, because the permission path spawns a resume child task.",
    {},
    async () => {
      try {
        const result = (await client.get('/api/approvals')) as {
          data?: ApprovalTaskRow[];
          error?: string;
        };
        if (result.error) {
          return errorResponse(`Couldn't list approvals: ${result.error}`);
        }
        const tasks = result.data ?? [];
        return jsonResponse({
          ok: true,
          count: tasks.length,
          tasks,
          note:
            tasks.length === 0
              ? 'No tasks waiting for approval.'
              : 'Use ohwow_approve_task { id } to approve (fires the attached deliverable action), or ohwow_reject_task { id, reason } to reject.',
        });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );

  server.tool(
    'ohwow_preview_approval',
    "[Approvals] Preview what ohwow_approve_task will actually fire — *without* flipping status. Returns the task, its attached deliverables (type, provider, status, content preview, target handle/conversation for DMs), whether the deliverable executor is in live-send mode, and a one-line verdict ('will send DM to @handle via Playwright for real', 'will mark done only — no deliverable', 'will dry-run log because executor live=false', 'task already resolved', etc.). Call this before ohwow_approve_task whenever the task description is vague or it's not obvious whether approval has external side-effects (DM / tweet / email). For permission-denied approvals, use ohwow_list_permission_requests instead.",
    {
      id: z.string().min(1).describe('Task id from ohwow_list_approvals.'),
    },
    async ({ id }) => {
      try {
        const result = (await client.get(`/api/approvals/${encodeURIComponent(id)}/preview`)) as {
          data?: {
            task: Record<string, unknown>;
            deliverables: Array<Record<string, unknown>>;
            liveMode: boolean;
            verdict: string;
          };
          error?: string;
        };
        if (result.error) return errorResponse(`Couldn't preview approval: ${result.error}`);
        if (!result.data) return errorResponse('Task not found.');
        return jsonResponse({ ok: true, ...result.data });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );

  server.tool(
    'ohwow_approve_task',
    "[Approvals] Approve a task that's currently in status=needs_approval. Flips status to 'approved', cascades any attached deliverables in pending_review to approved, and runs the real-world deliverable action (post tweet, send email, etc.) unless the workspace is in dry-run mode. Returns the execution result array so the caller can see whether sending succeeded. For permission-denied approvals, use ohwow_approve_permission_request instead.",
    {
      id: z.string().min(1).describe('Task id from ohwow_list_approvals.'),
    },
    async ({ id }) => {
      try {
        const result = (await client.post(`/api/approvals/${encodeURIComponent(id)}/approve`, {})) as {
          data?: { id: string; status: string; execution: unknown[] };
          error?: string;
        };
        if (result.error) return errorResponse(`Couldn't approve task: ${result.error}`);
        if (!result.data) return errorResponse('Task not found or not in needs_approval.');
        return jsonResponse({ ok: true, ...result.data });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );

  server.tool(
    'ohwow_reject_task',
    "[Approvals] Reject a task that's currently in status=needs_approval. Flips status to 'rejected', cascades any attached deliverables to rejected, and writes the optional reason to both the task and the deliverable for audit. No real-world action runs. For permission-denied tasks, use ohwow_approve_permission_request with mode='deny' instead so the failure is categorized correctly.",
    {
      id: z.string().min(1).describe('Task id from ohwow_list_approvals.'),
      reason: z
        .string()
        .optional()
        .describe('Why the task was rejected. Stored on both task and deliverable as rejection_reason. Helpful when the agent retries or when reviewing later.'),
    },
    async ({ id, reason }) => {
      try {
        const body: Record<string, unknown> = {};
        if (reason !== undefined) body.reason = reason;
        const result = (await client.post(
          `/api/approvals/${encodeURIComponent(id)}/reject`,
          body,
        )) as {
          data?: { id: string; status: string };
          error?: string;
        };
        if (result.error) return errorResponse(`Couldn't reject task: ${result.error}`);
        if (!result.data) return errorResponse('Task not found or not in needs_approval.');
        return jsonResponse({ ok: true, ...result.data });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );
}
