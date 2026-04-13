/**
 * Workspace MCP Tools
 *
 * Symmetric with the CLI's `ohwow workspace list` / `ohwow workspace use`
 * — lets a Claude Code session inspect every local workspace and switch
 * the MCP's target without restarting Claude Code or the MCP server.
 *
 *   ohwow_workspace_list  →  every workspace + mode + running status
 *   ohwow_workspace_use   →  reconnect this MCP session's api-client to
 *                            a different workspace's daemon (via switchTo)
 *
 * The switch flow:
 *   1. Validate name, look up port via portForWorkspace
 *   2. DaemonApiClient.switchTo() health-checks the target daemon
 *   3. On success, the api-client's internal baseUrl/token are swapped
 *      and ~/.ohwow/current-workspace is updated
 *   4. All subsequent tool calls in this MCP session target the new daemon
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  resolveActiveWorkspace,
  listWorkspaces,
  workspaceLayoutFor,
  readWorkspaceConfig,
  portForWorkspace,
  DEFAULT_WORKSPACE,
} from '../../config.js';
import { isDaemonRunning } from '../../daemon/lifecycle.js';
import type { DaemonApiClient } from '../api-client.js';

interface WorkspaceListRow {
  name: string;
  focused: boolean;
  mode: 'default' | 'local-only' | 'cloud';
  displayName?: string;
  port: number | null;
  running: boolean;
  pid?: number;
  cloudWorkspaceId?: string;
}

async function buildWorkspaceList(): Promise<WorkspaceListRow[]> {
  const focused = resolveActiveWorkspace().name;
  const all = Array.from(new Set([...listWorkspaces(), DEFAULT_WORKSPACE])).sort();
  const rows: WorkspaceListRow[] = [];
  for (const name of all) {
    const cfg = readWorkspaceConfig(name);
    const port = portForWorkspace(name);
    const layout = workspaceLayoutFor(name);
    let running = false;
    let pid: number | undefined;
    if (port !== null) {
      try {
        const status = await isDaemonRunning(layout.dataDir, port);
        running = status.running;
        pid = status.pid;
      } catch {
        // Treat as not running
      }
    }
    rows.push({
      name,
      focused: name === focused,
      mode: cfg ? cfg.mode : 'default',
      ...(cfg?.displayName ? { displayName: cfg.displayName } : {}),
      port,
      running,
      ...(pid !== undefined ? { pid } : {}),
      ...(cfg?.cloudWorkspaceId ? { cloudWorkspaceId: cfg.cloudWorkspaceId } : {}),
    });
  }
  return rows;
}

export function registerWorkspaceTools(server: McpServer, client: DaemonApiClient): void {
  // ohwow_workspace_list — discoverable inventory of every local workspace.
  server.tool(
    'ohwow_workspace_list',
    '[Workspace] List every local workspace under ~/.ohwow/workspaces with mode, port, and live running status. Use this to discover what workspaces exist before switching with ohwow_workspace_use.',
    {},
    async () => {
      try {
        const rows = await buildWorkspaceList();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ workspaces: rows }, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: `Error listing workspaces: ${err instanceof Error ? err.message : err}` },
          ],
          isError: true,
        };
      }
    },
  );

  // ohwow_workspace_use — switch this MCP session's target workspace.
  server.tool(
    'ohwow_workspace_use',
    '[Workspace] Switch which workspace this MCP session targets. Reconnects the api-client to the named workspace\'s daemon (must already be running — start it with `ohwow workspace start <name>` from a terminal first if needed). Also updates ~/.ohwow/current-workspace so future sessions default to it. All subsequent tool calls in this MCP session will hit the new workspace.',
    {
      name: z.string().describe('Workspace name (must already exist under ~/.ohwow/workspaces or be the legacy "default")'),
    },
    async ({ name }) => {
      try {
        const before = resolveActiveWorkspace().name;
        const result = await client.switchTo(name);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  ok: true,
                  switched: true,
                  previous: before,
                  current: result.workspaceName,
                  port: result.port,
                  message: `MCP session now targets workspace "${result.workspaceName}" on port ${result.port}. Future MCP launches will also default to this workspace.`,
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
              text: JSON.stringify(
                {
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
