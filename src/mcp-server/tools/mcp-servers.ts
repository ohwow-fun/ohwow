/**
 * MCP Server Management Tools
 *
 * Typed tools for registering, listing, removing, and testing third-party
 * MCP servers in the currently focused ohwow workspace. Used by IDE/CLI
 * clients (Claude Code, Cursor, etc.) to wire external MCP servers into a
 * workspace's agent tool surface WITHOUT sending raw credentials through the
 * orchestrator's natural-language chat path.
 *
 * Credentials (`headers` for HTTP transports, `env` for stdio, structured
 * `auth` blocks) are forwarded straight to the daemon over the local bearer-
 * authed /api/mcp/servers endpoint, persisted in the per-workspace SQLite's
 * `runtime_settings.global_mcp_servers` row, and never pass through the LLM
 * context. The list tool returns only `<set>` flags for credential fields.
 *
 * Security caveats callers must know
 * ----------------------------------
 * 1. Values in `headers` / `env` / `auth` are treated as secrets: they are
 *    NOT returned by ohwow_list_mcp_servers, not echoed in the `add` tool's
 *    response, and not included in daemon logs (info-level logging is
 *    redacted in src/api/routes/mcp.ts).
 * 2. At-rest storage reuses the existing workspace-scoped SQLite DB. The DB
 *    itself is protected by the file permissions on ~/.ohwow/workspaces/<ws>/
 *    — matching the posture of every other credential ohwow currently stores
 *    (anthropicApiKey, connector tokens, etc.). A dedicated encrypted secret
 *    store does not exist yet and is out of scope for this feature.
 * 3. URLs go through the existing SSRF guard (`validatePublicUrl`) so
 *    private/link-local addresses are rejected at register time.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

const NAME_DESCRIPTION =
  'Workspace-unique identifier for this MCP server (alphanumeric, dashes, underscores). Used as the namespace prefix when the server\'s tools are exposed to agents (e.g. name="avenued" → tools become mcp__avenued__<tool>).';

const HEADERS_DESCRIPTION =
  'SENSITIVE. HTTP headers sent with every request to the MCP server, e.g. { "Authorization": "Bearer sk-..." }. Stored encrypted-equivalent in the workspace DB (never returned by list, never logged in plaintext, never exposed to agent context — injected at the transport layer).';

const ENV_DESCRIPTION =
  'SENSITIVE. Environment variables for the stdio subprocess, e.g. { "GITHUB_TOKEN": "ghp_..." }. Stored in the workspace DB and passed to the child process at spawn time. Never returned by list, never logged in plaintext, never exposed to agent context.';

export function registerMcpServerTools(server: McpServer, client: DaemonApiClient): void {
  // ─── ohwow_add_mcp_server ────────────────────────────────────────
  server.tool(
    'ohwow_add_mcp_server',
    '[MCP] Register a third-party MCP server in the current workspace. Its tools become available to all agents (and the orchestrator) on the next turn. Credentials in `headers` or `env` are SENSITIVE — they stay on the local process, never transit through the LLM, and are never returned by list/inspect calls. Use for hooking external platforms (Stripe, GitHub, Notion, custom internal MCPs) into an ohwow workspace.',
    {
      name: z.string().describe(NAME_DESCRIPTION),
      transport: z
        .enum(['http', 'stdio'])
        .describe('Transport type. "http" for Streamable HTTP servers (most hosted MCPs); "stdio" for local subprocess servers launched with command+args.'),
      url: z
        .string()
        .optional()
        .describe('Required for transport="http". Full URL of the MCP endpoint, e.g. https://example.com/api/mcp. Must be a publicly routable HTTPS URL — private/link-local/metadata IPs are rejected.'),
      command: z
        .string()
        .optional()
        .describe('Required for transport="stdio". Executable to run, e.g. "npx" or "node".'),
      args: z
        .array(z.string())
        .optional()
        .describe('For transport="stdio". Command-line arguments to pass to the executable.'),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe(HEADERS_DESCRIPTION),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe(ENV_DESCRIPTION),
      description: z
        .string()
        .optional()
        .describe('Human-readable description of what this server does. Shown in ohwow_list_mcp_servers output.'),
      enabled: z
        .boolean()
        .optional()
        .describe('Whether the server should be connected on process startup. Default: true.'),
    },
    async ({ name, transport, url, command, args, headers, env, description, enabled }) => {
      try {
        const body: Record<string, unknown> = { name, transport };
        if (url) body.url = url;
        if (command) body.command = command;
        if (args) body.args = args;
        if (headers) body.headers = headers;
        if (env) body.env = env;
        if (description) body.description = description;
        if (enabled === false) body.enabled = false;

        const result = await client.post('/api/mcp/servers', body) as {
          ok?: boolean;
          server?: unknown;
          error?: string;
        };

        if (result.error) {
          return {
            content: [{ type: 'text' as const, text: `Couldn't register MCP server: ${result.error}` }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  ok: true,
                  server: result.server,
                  note: 'Server registered. Credentials stored on the process and redacted from this response. Call ohwow_test_mcp_server to verify connectivity and list exposed tools.',
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── ohwow_list_mcp_servers ──────────────────────────────────────
  server.tool(
    'ohwow_list_mcp_servers',
    '[MCP] List all third-party MCP servers registered in the current workspace. Response shows name, transport, URL (for HTTP) or command (for stdio), description, enabled flag, and — for servers with credentials — the header/env KEY names replaced with "<set>". Actual credential values are NEVER returned. Does NOT perform live connections; use ohwow_test_mcp_server for that.',
    {},
    async () => {
      try {
        const result = await client.get('/api/mcp/servers') as { servers?: unknown[] };
        const servers = result.servers ?? [];
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ count: servers.length, servers }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── ohwow_remove_mcp_server ─────────────────────────────────────
  server.tool(
    'ohwow_remove_mcp_server',
    '[MCP] Remove a registered MCP server from the current workspace by name. Disconnects the server immediately and drops its tools from the agent tool surface on the next turn. The stored credentials are deleted along with the config.',
    {
      name: z.string().describe('Name of the MCP server to remove (must match a name from ohwow_list_mcp_servers).'),
    },
    async ({ name }) => {
      try {
        const result = await client.del(`/api/mcp/servers/${encodeURIComponent(name)}`) as {
          ok?: boolean;
          removed?: string;
          error?: string;
        };

        if (result.error) {
          return {
            content: [{ type: 'text' as const, text: `Couldn't remove MCP server: ${result.error}` }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: true, removed: result.removed ?? name }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── ohwow_test_mcp_server ───────────────────────────────────────
  server.tool(
    'ohwow_test_mcp_server',
    '[MCP] Verify a registered MCP server connects, and return the names of tools it exposes. Uses the stored config (including credentials) but returns only tool NAMES — no schemas, no credential echo, no connection details. Use this right after ohwow_add_mcp_server to confirm the server is reachable and authenticated, and to discover what tools will become available to agents.',
    {
      name: z.string().describe('Name of a registered MCP server (from ohwow_list_mcp_servers).'),
    },
    async ({ name }) => {
      try {
        const result = await client.post(`/api/mcp/servers/${encodeURIComponent(name)}/test`, {}) as {
          success?: boolean;
          toolCount?: number;
          toolNames?: string[];
          latencyMs?: number;
          error?: string;
        };

        if (!result.success) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    ok: false,
                    error: result.error ?? 'Connection failed',
                    latencyMs: result.latencyMs,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  ok: true,
                  toolCount: result.toolCount ?? 0,
                  toolNames: result.toolNames ?? [],
                  latencyMs: result.latencyMs,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
