/**
 * Permission Requests MCP Tools
 *
 * Companion to ohwow_grant_agent_path / list / revoke from commit 47a6d42.
 * Those tools are the "operator pre-grants access" path. These are the
 * "operator answers a runtime denial" path: when an agent calls a
 * filesystem or bash tool on a path outside its allowlist, the runtime
 * throws PermissionDeniedError, the task lands in needs_approval with a
 * structured permission_request payload, and these tools let the operator
 * approve once / approve always / deny via a single MCP call.
 *
 * The daemon-side route at /api/permission-requests handles the actual
 * write — these tools are thin wrappers around it for IDE/CLI clients
 * (Claude Code, Cursor, etc.).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

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

interface PermissionRequestRow {
  task_id: string;
  agent_id: string;
  agent_name: string | null;
  task_title: string;
  request: {
    tool_name: string;
    attempted_path: string;
    suggested_exact: string;
    suggested_parent: string;
    guard_reason: string;
    iteration: number | null;
    timestamp: string;
  };
  created_at: string;
  updated_at: string;
}

export function registerPermissionRequestTools(
  server: McpServer,
  client: DaemonApiClient,
): void {
  // ─── ohwow_list_permission_requests ──────────────────────────────
  server.tool(
    'ohwow_list_permission_requests',
    '[Permissions] List every task currently paused on a filesystem or bash permission request. Returns the task id, agent name, attempted path, suggested exact + parent paths the operator can grant, the guard reason, and when the denial happened. These are the actionable items in the "agent wants access to X" queue. Pair with ohwow_approve_permission_request to resolve any row. Workspace-scoped to the focused daemon.',
    {},
    async () => {
      try {
        const result = (await client.get('/api/permission-requests')) as {
          data?: PermissionRequestRow[];
          error?: string;
        };
        if (result.error) {
          return errorResponse(`Couldn't list permission requests: ${result.error}`);
        }
        const requests = result.data ?? [];
        return jsonResponse({
          ok: true,
          count: requests.length,
          requests,
          note: requests.length === 0
            ? 'No agents are waiting on a permission decision right now.'
            : 'Use ohwow_approve_permission_request with the task_id to approve once, approve always, or deny.',
        });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );

  // ─── ohwow_approve_permission_request ────────────────────────────
  server.tool(
    'ohwow_approve_permission_request',
    '[Permissions] Resolve a paused permission request. mode="once" grants the path for this single resumed run only and does NOT persist a row in agent_file_access_paths — use it for one-off operator approvals. mode="always" persists the grant by writing through the same agent_file_access_paths path that ohwow_grant_agent_path writes to, so future runs of this agent stay unblocked. mode="deny" terminates the original task with failure_category=permission_denied and does NOT spawn a resume. On approve, the original task is marked status=approved and a NEW child task is spawned (parent_task_id pointing back) that re-runs the work from scratch with the expanded guard. The child task id is returned so callers can poll its status.',
    {
      task_id: z.string().describe('Task id from ohwow_list_permission_requests. Must currently be in status=needs_approval with approval_reason=permission_denied; the route 409s otherwise.'),
      mode: z.enum(['once', 'always', 'deny']).describe('"once" = resume with an ephemeral grant on the child task only. "always" = persist the grant via agent_file_access_paths so future runs work. "deny" = terminate the task without resuming.'),
      scope: z.enum(['exact', 'parent', 'edit']).optional().describe('Which path to grant (ignored for mode=deny). "exact" = the exact file/dir the agent asked for (default). "parent" = the parent directory of the exact path, so sibling files also work. "edit" = use the explicit `path` field below; the operator overrides what was suggested.'),
      path: z.string().optional().describe('Required only when scope="edit". Absolute directory path to grant. Must live inside the user\'s home directory and not under a blocked system path.'),
    },
    async ({ task_id, mode, scope, path }) => {
      try {
        const body: Record<string, unknown> = { mode };
        if (scope !== undefined) body.scope = scope;
        if (path !== undefined) body.path = path;

        const result = (await client.post(
          `/api/permission-requests/${encodeURIComponent(task_id)}/approve`,
          body,
        )) as {
          ok?: boolean;
          mode?: string;
          scope?: string;
          granted_path?: string;
          task_id?: string;
          child_task_id?: string;
          error?: string;
        };

        if (result.error) {
          return errorResponse(`Couldn't approve permission request: ${result.error}`);
        }

        return jsonResponse({
          ok: true,
          ...result,
          note: mode === 'deny'
            ? 'Task marked failed with failure_category=permission_denied. No resume spawned.'
            : `Resumed as task ${result.child_task_id?.slice(0, 8) ?? '<unknown>'}. Use ohwow_get_task with the child id to see when it completes.`,
        });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );
}
