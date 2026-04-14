/**
 * Agent Management MCP Tools
 *
 * Typed tools for creating, reading, updating, and deleting agents in the
 * currently focused ohwow workspace. These are the write-path counterparts
 * to `ohwow_list_agents` and `ohwow_run_agent` in core.ts: they let IDE/CLI
 * clients (Claude Code, Cursor, etc.) build and iterate on agent rosters
 * without going through the orchestrator's free-form `ohwow_chat` path.
 *
 * Why these exist as typed tools instead of an orchestrator intent
 * ----------------------------------------------------------------
 * Before these tools existed, the only way to create an agent from an MCP
 * client was `ohwow_chat("create a new agent named X with this prompt...")`.
 * That path routes through the LLM planner, which does not have a direct
 * `create_agent` primitive in toolRegistry — so the planner falls back to
 * inspecting ambient state (list_agents, get_daemon_info, desktop_*) in
 * a loop, times out, and writes nothing. These typed tools bypass the
 * planner entirely: the MCP client names the action, parameters land on
 * the daemon over the local bearer-authed /api/agents endpoint, and the
 * row is written in a single HTTP call.
 *
 * Name resolution
 * ---------------
 * The MCP tools use workspace-unique `name` as the lookup key. The daemon
 * routes still identify rows by `id` (UUID), so get/update/delete all list
 * the workspace's agents, match the requested name locally, and then target
 * the resolved id against the existing by-id routes. One extra GET per
 * call — acceptable for a write-path tool used interactively.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

const NAME_DESCRIPTION =
  'Workspace-unique identifier for this agent. Alphanumeric plus dashes and underscores only (no spaces). Used by ohwow_get_agent, ohwow_update_agent, ohwow_delete_agent, and ohwow_run_agent to look up the row.';

const SYSTEM_PROMPT_DESCRIPTION =
  "The agent's core instructions. Stored verbatim and injected as the system message on every task run. Business-sensitive context belongs here; it is scoped to the current workspace and is NOT returned by ohwow_list_agents (which returns only summary fields). Use ohwow_get_agent to read it back.";

const TOOL_ALLOWLIST_DESCRIPTION =
  'Explicit list of tool names the agent is allowed to call. If omitted, the agent inherits the workspace default tool surface. If provided, the agent sees ONLY these tools. Names must be either internal tool identifiers (e.g. "list_tasks", "scrape_url") or external MCP-server tools in the "mcp__<server>__<tool>" shape. Unknown internal names are rejected at create time so misconfigured agents fail fast.';

interface AgentRow {
  id: string;
  name: string;
  workspace_id?: string;
  [key: string]: unknown;
}

async function resolveAgentByName(
  client: DaemonApiClient,
  name: string,
): Promise<AgentRow | null> {
  const data = (await client.get('/api/agents')) as { data?: AgentRow[] };
  const agents = data.data ?? [];
  return agents.find((a) => a.name === name) ?? null;
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

export function registerAgentManagementTools(
  server: McpServer,
  client: DaemonApiClient,
): void {
  // ─── ohwow_create_agent ──────────────────────────────────────────
  server.tool(
    'ohwow_create_agent',
    '[Agents] Create a new agent in the current workspace. Writes directly to the agents table via the local daemon. Use this instead of ohwow_chat for agent creation — the orchestrator has no typed create primitive and will loop on ambient-state inspection if asked to create an agent via chat.',
    {
      name: z.string().describe(NAME_DESCRIPTION),
      displayName: z
        .string()
        .optional()
        .describe('Human-readable label shown in UIs. Defaults to `name` when omitted.'),
      description: z
        .string()
        .optional()
        .describe('Short summary of what the agent does. Shown in list views and agent pickers.'),
      systemPrompt: z.string().describe(SYSTEM_PROMPT_DESCRIPTION),
      toolAllowlist: z
        .array(z.string())
        .optional()
        .describe(TOOL_ALLOWLIST_DESCRIPTION),
      webSearchEnabled: z
        .boolean()
        .optional()
        .describe('Whether the built-in web_search tool should be available to this agent. Defaults to false — conservative default so narrow allowlists do not accidentally grant web access. When `toolAllowlist` is set, this flag is overridden by the allowlist: the agent sees web_search only if "web_search" is explicitly in the list.'),
      role: z
        .string()
        .optional()
        .describe('Free-text role label for categorization (e.g. "analyst", "writer"). Defaults to "assistant".'),
      enabled: z
        .boolean()
        .optional()
        .describe('Whether the agent is enabled and eligible to run. Default: true.'),
      scheduled: z
        .object({
          cron: z.string().describe('Cron expression (5- or 6-field).'),
          timezone: z.string().optional().describe('IANA timezone name (e.g. "America/New_York"). Defaults to the workspace tz.'),
        })
        .optional()
        .describe('Optional cron schedule. Stored with the agent but not yet wired to the scheduler — runs must be triggered manually via ohwow_run_agent for now.'),
    },
    async ({ name, displayName, description, systemPrompt, toolAllowlist, webSearchEnabled, role, enabled, scheduled }) => {
      try {
        const body: Record<string, unknown> = {
          name,
          system_prompt: systemPrompt,
        };
        if (displayName !== undefined) body.display_name = displayName;
        if (description !== undefined) body.description = description;
        if (role !== undefined) body.role = role;
        if (enabled !== undefined) body.enabled = enabled;
        if (scheduled !== undefined) body.scheduled = scheduled;

        const config: Record<string, unknown> = {};
        if (toolAllowlist !== undefined) {
          config.tools_enabled = toolAllowlist;
          config.tools_mode = 'allowlist';
        }
        if (webSearchEnabled !== undefined) config.web_search_enabled = webSearchEnabled;
        if (Object.keys(config).length > 0) body.config = config;

        const result = (await client.post('/api/agents', body)) as {
          data?: AgentRow;
          error?: string;
        };

        if (result.error) {
          return errorResponse(`Couldn't create agent: ${result.error}`);
        }

        return jsonResponse({
          ok: true,
          agent: result.data,
          note: 'Agent created. Use ohwow_run_agent with this agent\'s name or id to dispatch a task.',
        });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );

  // ─── ohwow_get_agent ─────────────────────────────────────────────
  server.tool(
    'ohwow_get_agent',
    '[Agents] Get an agent\'s full configuration by name or id, including the system prompt, tool allowlist, role, schedule, enabled flag, and timestamps. Use this instead of ohwow_list_agents when you need to inspect or iterate on a specific agent\'s system prompt — list_agents returns summary rows and does not include the prompt.',
    {
      name: z
        .string()
        .optional()
        .describe('Workspace-unique agent name. Provide this OR `id`.'),
      id: z
        .string()
        .optional()
        .describe('Agent UUID. Provide this OR `name`.'),
    },
    async ({ name, id }) => {
      try {
        if (!name && !id) {
          return errorResponse('Provide either `name` or `id`.');
        }

        let resolvedId = id;
        if (!resolvedId && name) {
          const match = await resolveAgentByName(client, name);
          if (!match) {
            return errorResponse(`No agent named "${name}" in this workspace.`);
          }
          resolvedId = match.id;
        }

        const result = (await client.get(
          `/api/agents/${encodeURIComponent(resolvedId!)}`,
        )) as { data?: AgentRow; error?: string };

        if (result.error || !result.data) {
          return errorResponse(result.error ?? 'Agent not found');
        }

        return jsonResponse({ ok: true, agent: result.data });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );

  // ─── ohwow_update_agent ──────────────────────────────────────────
  server.tool(
    'ohwow_update_agent',
    '[Agents] Update fields on an existing agent. Use this to iterate on a system prompt, tighten a tool allowlist, rename, or toggle enabled. Identify the agent by `name` or `id`. Any field left undefined is untouched. Agents never pin a model — the router picks per task.',
    {
      name: z.string().optional().describe('Workspace-unique agent name (provide this OR `id`).'),
      id: z.string().optional().describe('Agent UUID (provide this OR `name`).'),
      newName: z
        .string()
        .optional()
        .describe('Rename the agent. Must remain workspace-unique and match the alphanumeric+dash+underscore constraint.'),
      displayName: z.string().optional().describe('Updated human-readable label.'),
      description: z.string().optional().describe('Updated short summary.'),
      systemPrompt: z.string().optional().describe('Replace the system prompt entirely.'),
      toolAllowlist: z
        .array(z.string())
        .optional()
        .describe('Replace the tool allowlist. Same validation rules as ohwow_create_agent.'),
      webSearchEnabled: z
        .boolean()
        .optional()
        .describe('Toggle the built-in web_search tool. Overridden by the allowlist when one is active — see ohwow_create_agent.'),
      role: z.string().optional().describe('Updated role label.'),
      enabled: z.boolean().optional().describe('Toggle the agent on/off.'),
      scheduled: z
        .object({
          cron: z.string(),
          timezone: z.string().optional(),
        })
        .optional()
        .describe('Replace the cron schedule.'),
    },
    async ({ name, id, newName, displayName, description, systemPrompt, toolAllowlist, webSearchEnabled, role, enabled, scheduled }) => {
      try {
        if (!name && !id) {
          return errorResponse('Provide either `name` or `id`.');
        }

        let resolvedId = id;
        if (!resolvedId && name) {
          const match = await resolveAgentByName(client, name);
          if (!match) {
            return errorResponse(`No agent named "${name}" in this workspace.`);
          }
          resolvedId = match.id;
        }

        const body: Record<string, unknown> = {};
        if (newName !== undefined) body.name = newName;
        if (description !== undefined) body.description = description;
        if (systemPrompt !== undefined) body.system_prompt = systemPrompt;
        if (role !== undefined) body.role = role;
        if (enabled !== undefined) body.enabled = enabled;
        if (displayName !== undefined) body.display_name = displayName;
        if (scheduled !== undefined) body.scheduled = scheduled;

        const configPatch: Record<string, unknown> = {};
        if (toolAllowlist !== undefined) {
          configPatch.tools_enabled = toolAllowlist;
          configPatch.tools_mode = 'allowlist';
        }
        if (webSearchEnabled !== undefined) configPatch.web_search_enabled = webSearchEnabled;
        if (Object.keys(configPatch).length > 0) body.config = configPatch;

        if (Object.keys(body).length === 0) {
          return errorResponse('No fields provided to update.');
        }

        const result = (await client.patch(
          `/api/agents/${encodeURIComponent(resolvedId!)}`,
          body,
        )) as { data?: AgentRow; error?: string };

        if (result.error) {
          return errorResponse(`Couldn't update agent: ${result.error}`);
        }

        return jsonResponse({ ok: true, agent: result.data });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );

  // ─── ohwow_grant_agent_path ──────────────────────────────────────
  server.tool(
    'ohwow_grant_agent_path',
    '[Agents] Grant an agent permission to read/write files under a local directory. Writes a row to agent_file_access_paths that the FileAccessGuard reads on every task run, so the agent\'s filesystem tools (local_read_file, local_write_file, run_bash, etc.) will accept paths inside the granted directory. Without this, a narrowly-scoped agent hits "path outside allowed directories" and the task either fails the hallucination gate or routes to needs_approval. The daemon validates that the path exists, is a directory, lives inside the user\'s home, and isn\'t a sensitive subdirectory like .ssh or .gnupg. Identify the agent by `name` or `id`.',
    {
      name: z.string().optional().describe('Workspace-unique agent name (provide this OR `id`).'),
      id: z.string().optional().describe('Agent UUID, or the literal string "__orchestrator__" to grant paths to the orchestrator itself (provide this OR `name`).'),
      path: z.string().describe('Absolute directory path to grant access to. Must exist, be a directory, live inside the user\'s home, and not be under .ssh, .gnupg, /etc, /var, /usr, etc. Tildes are not expanded — pass a fully-resolved path.'),
      label: z.string().optional().describe('Optional human-readable label shown in UIs (e.g. "living docs (diary)", "workspace data"). Purely cosmetic.'),
    },
    async ({ name, id, path, label }) => {
      try {
        if (!name && !id) {
          return errorResponse('Provide either `name` or `id`.');
        }

        let resolvedId = id;
        if (!resolvedId && name) {
          const match = await resolveAgentByName(client, name);
          if (!match) {
            return errorResponse(`No agent named "${name}" in this workspace.`);
          }
          resolvedId = match.id;
        }

        const result = (await client.post(
          `/api/agents/${encodeURIComponent(resolvedId!)}/file-access`,
          { path, label },
        )) as { data?: { path: string; label: string | null }; error?: string };

        if (result.error) {
          return errorResponse(`Couldn't grant path: ${result.error}`);
        }

        return jsonResponse({
          ok: true,
          agent: name ?? resolvedId,
          path: result.data?.path ?? path,
          label: result.data?.label ?? label ?? null,
          note: 'Path granted. FileAccessGuard re-reads this table on every task run, so the next run will see the new access.',
        });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );

  // ─── ohwow_list_agent_paths ──────────────────────────────────────
  server.tool(
    'ohwow_list_agent_paths',
    '[Agents] List all filesystem paths granted to an agent. Returns rows from agent_file_access_paths with id, path, label, and created_at. Use the returned `id` with ohwow_revoke_agent_path to remove a specific row. Identify the agent by `name` or `id`.',
    {
      name: z.string().optional().describe('Workspace-unique agent name (provide this OR `id`).'),
      id: z.string().optional().describe('Agent UUID, or the literal string "__orchestrator__" for orchestrator-scoped paths (provide this OR `name`).'),
    },
    async ({ name, id }) => {
      try {
        if (!name && !id) {
          return errorResponse('Provide either `name` or `id`.');
        }

        let resolvedId = id;
        if (!resolvedId && name) {
          const match = await resolveAgentByName(client, name);
          if (!match) {
            return errorResponse(`No agent named "${name}" in this workspace.`);
          }
          resolvedId = match.id;
        }

        const result = (await client.get(
          `/api/agents/${encodeURIComponent(resolvedId!)}/file-access`,
        )) as { data?: Array<{ id: string; path: string; label: string | null; created_at: string }>; error?: string };

        if (result.error) {
          return errorResponse(`Couldn't list paths: ${result.error}`);
        }

        return jsonResponse({
          ok: true,
          agent: name ?? resolvedId,
          paths: result.data ?? [],
        });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );

  // ─── ohwow_revoke_agent_path ─────────────────────────────────────
  server.tool(
    'ohwow_revoke_agent_path',
    '[Agents] Revoke an agent\'s access to a filesystem path. Identify the agent by `name` or `id`, then identify the row by either `pathId` (from ohwow_list_agent_paths) or `path` (exact match — the tool lists and resolves locally). Idempotent on a missing row.',
    {
      name: z.string().optional().describe('Workspace-unique agent name (provide this OR `id`).'),
      id: z.string().optional().describe('Agent UUID, or the literal string "__orchestrator__" (provide this OR `name`).'),
      pathId: z.string().optional().describe('The row id from ohwow_list_agent_paths. Takes precedence over `path` when both are provided.'),
      path: z.string().optional().describe('Absolute directory path. The tool lists existing grants and deletes the matching row. Used when the caller doesn\'t know the row id. Exact-match, fully-resolved path.'),
    },
    async ({ name, id, pathId, path }) => {
      try {
        if (!name && !id) {
          return errorResponse('Provide either `name` or `id`.');
        }
        if (!pathId && !path) {
          return errorResponse('Provide either `pathId` or `path`.');
        }

        let resolvedId = id;
        if (!resolvedId && name) {
          const match = await resolveAgentByName(client, name);
          if (!match) {
            return errorResponse(`No agent named "${name}" in this workspace.`);
          }
          resolvedId = match.id;
        }

        let resolvedPathId = pathId;
        if (!resolvedPathId && path) {
          const listResult = (await client.get(
            `/api/agents/${encodeURIComponent(resolvedId!)}/file-access`,
          )) as { data?: Array<{ id: string; path: string }>; error?: string };
          if (listResult.error) {
            return errorResponse(`Couldn't list paths for match: ${listResult.error}`);
          }
          const row = (listResult.data ?? []).find((r) => r.path === path);
          if (!row) {
            return errorResponse(`No granted path matches "${path}" for this agent.`);
          }
          resolvedPathId = row.id;
        }

        const result = (await client.del(
          `/api/agents/${encodeURIComponent(resolvedId!)}/file-access/${encodeURIComponent(resolvedPathId!)}`,
        )) as { success?: boolean; error?: string };

        if (result.error) {
          return errorResponse(`Couldn't revoke path: ${result.error}`);
        }

        return jsonResponse({
          ok: true,
          agent: name ?? resolvedId,
          revoked: resolvedPathId,
        });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );

  // ─── ohwow_delete_agent ──────────────────────────────────────────
  server.tool(
    'ohwow_delete_agent',
    '[Agents] Delete an agent from the current workspace. Also drops the agent\'s memory rows. Identify by `name` or `id`. This is destructive — there is no undo.',
    {
      name: z.string().optional().describe('Workspace-unique agent name (provide this OR `id`).'),
      id: z.string().optional().describe('Agent UUID (provide this OR `name`).'),
    },
    async ({ name, id }) => {
      try {
        if (!name && !id) {
          return errorResponse('Provide either `name` or `id`.');
        }

        let resolvedId = id;
        let resolvedName = name;
        if (!resolvedId && name) {
          const match = await resolveAgentByName(client, name);
          if (!match) {
            return errorResponse(`No agent named "${name}" in this workspace.`);
          }
          resolvedId = match.id;
          resolvedName = match.name;
        }

        const result = (await client.del(
          `/api/agents/${encodeURIComponent(resolvedId!)}`,
        )) as { data?: { deleted?: boolean }; error?: string };

        if (result.error) {
          return errorResponse(`Couldn't delete agent: ${result.error}`);
        }

        return jsonResponse({
          ok: true,
          deleted: resolvedName ?? resolvedId,
        });
      } catch (err) {
        return errorResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  );
}
