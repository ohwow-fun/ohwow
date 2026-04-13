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
      model: z
        .string()
        .optional()
        .describe('Model identifier (e.g. "claude-opus-4-6", "gpt-5", "qwen3:0.6b"). If omitted, uses the workspace default.'),
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
    async ({ name, displayName, description, systemPrompt, toolAllowlist, model, role, enabled, scheduled }) => {
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
        if (model !== undefined) config.model = model;
        if (toolAllowlist !== undefined) {
          config.tools_enabled = toolAllowlist;
          config.tools_mode = 'allowlist';
        }
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
    '[Agents] Get an agent\'s full configuration by name or id, including the system prompt, tool allowlist, model policy, role, schedule, enabled flag, and timestamps. Use this instead of ohwow_list_agents when you need to inspect or iterate on a specific agent\'s system prompt — list_agents returns summary rows and does not include the prompt.',
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
    '[Agents] Update fields on an existing agent. Use this to iterate on a system prompt, tighten a tool allowlist, rename, toggle enabled, or swap model after a test run. Identify the agent by `name` or `id`. Any field left undefined is untouched.',
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
      model: z.string().optional().describe('Updated model identifier.'),
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
    async ({ name, id, newName, displayName, description, systemPrompt, toolAllowlist, model, role, enabled, scheduled }) => {
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
        if (model !== undefined) configPatch.model = model;
        if (toolAllowlist !== undefined) {
          configPatch.tools_enabled = toolAllowlist;
          configPatch.tools_mode = 'allowlist';
        }
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
