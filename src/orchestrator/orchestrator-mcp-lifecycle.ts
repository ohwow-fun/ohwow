/**
 * McpLifecycle — owns the MCP client manager, the in-memory server list,
 * and the reload status the daemon health endpoints surface. Extracted
 * from LocalOrchestrator so the class doesn't have to house two DB-read
 * branches (reload + ensureConnected), three mutation paths (reload /
 * ensureConnected / close), and the onElicitation wiring inline.
 *
 * LocalOrchestrator keeps thin `closeMcp` / `reloadMcpServers` /
 * `getMcpStatus` delegations so API routes (`src/api/routes/mcp.ts`) and
 * the chat loops don't need to know about the lifecycle class.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { McpServerConfig } from '../mcp/types.js';
import { McpClientManager, type ElicitationHandler } from '../mcp/client.js';
import { logger } from '../lib/logger.js';
import type { PermissionBroker } from './orchestrator-approvals.js';

export interface McpReloadStatus {
  ok: boolean;
  serverCount: number;
  toolCount: number;
  errors: Array<{ serverName: string; error: string }>;
  lastUpdatedMs: number;
}

export class McpLifecycle {
  private clients: McpClientManager | null = null;
  private servers: McpServerConfig[];
  private reloadStatus: McpReloadStatus | null = null;

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly broker: PermissionBroker,
    /** Called after every connection mutation so the DigitalBody organ
     * table reflects the current mcp client state. */
    private readonly syncOrgan: () => void,
    initialServers: McpServerConfig[],
  ) {
    this.servers = initialServers;
  }

  // -- Read-side accessors for the chat loops + tool context --

  getClients(): McpClientManager | null {
    return this.clients;
  }

  getServers(): readonly McpServerConfig[] {
    return this.servers;
  }

  getServerCount(): number {
    return this.servers.length;
  }

  getServerNames(): string[] {
    return this.servers.map((s) => s.name);
  }

  getToolDefinitions() {
    return this.clients?.getToolDefinitions() ?? [];
  }

  hasTools(): boolean {
    return this.getToolDefinitions().length > 0;
  }

  getStatus(): McpReloadStatus | null {
    return this.reloadStatus;
  }

  // -- Lifecycle transitions --

  /**
   * Reload the MCP server registry from the per-workspace DB and
   * reconnect. Called by the typed `ohwow_add_mcp_server` /
   * `ohwow_remove_mcp_server` tools via POST /api/mcp/servers so newly
   * registered servers are live without a daemon restart.
   *
   * Unlike `ensureConnected`, this always reads from runtime_settings
   * and overwrites the in-memory list — the constructor config (if any)
   * is superseded for the remainder of the process.
   */
  async reload(): Promise<void> {
    let fresh: McpServerConfig[] = [];
    try {
      const { data } = await this.db
        .from('runtime_settings')
        .select('value')
        .eq('key', 'global_mcp_servers')
        .maybeSingle();
      if (data) {
        // The SQLite adapter (parseJsonColumns in src/db/sqlite-adapter.ts)
        // auto-parses JSON-shaped string columns on read, so `value` is
        // already an array by the time we get it. Calling JSON.parse() on
        // an array coerces it to "[object Object]" and throws. Accept
        // either shape so we tolerate adapter behavior changes and
        // historical rows.
        const raw = (data as { value: unknown }).value;
        if (Array.isArray(raw)) {
          fresh = raw as McpServerConfig[];
        } else if (typeof raw === 'string') {
          try {
            const parsed = JSON.parse(raw);
            fresh = Array.isArray(parsed) ? (parsed as McpServerConfig[]) : [];
          } catch (parseErr) {
            // Corrupted row — log and treat as empty rather than poisoning
            // the in-memory state. The row is left in place so a future
            // recovery tool can inspect it.
            logger.warn(
              { err: parseErr },
              '[mcp] reloadMcpServers: runtime_settings.global_mcp_servers is corrupted; treating as empty',
            );
            fresh = [];
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, '[mcp] reloadMcpServers: failed to read runtime_settings');
      return;
    }

    this.servers = fresh;
    // Tear down existing clients and reconnect immediately so the next
    // orchestrator turn sees the updated tool surface.
    if (this.clients) {
      await this.clients.close().catch(() => {});
      this.clients = null;
    }
    if (fresh.length > 0) {
      await this.ensureConnected(true);
    } else {
      // Empty list — sync organ state so consumers see no MCP tools.
      this.syncOrgan();
    }
  }

  /**
   * Ensure MCP clients are connected. Lazy-initializes on first use.
   * When `force=true`, closes existing connections and reconnects (for
   * crash recovery).
   */
  async ensureConnected(force = false): Promise<void> {
    if (this.clients && !force) return;

    // Load servers: prefer constructor config, fall back to DB.
    let servers = this.servers;
    if (servers.length === 0) {
      try {
        const { data } = await this.db
          .from('runtime_settings')
          .select('value')
          .eq('key', 'global_mcp_servers')
          .maybeSingle();
        if (data) {
          // SQLite adapter auto-parses JSON columns on read. Accept
          // either an already-parsed array or (defensively) a raw JSON
          // string.
          const raw = (data as { value: unknown }).value;
          if (Array.isArray(raw)) {
            servers = raw as McpServerConfig[];
          } else if (typeof raw === 'string') {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) servers = parsed as McpServerConfig[];
            } catch {
              // Corrupted row — leave servers as [].
            }
          }
        }
      } catch {
        // DB not available, skip.
      }
    }

    if (servers.length === 0) return;

    if (force && this.clients) {
      await this.clients.close().catch(() => {});
      this.clients = null;
    }

    const onElicitation: ElicitationHandler = async (_serverName, _message, _schema) => {
      // Elicitation requests are surfaced as events — the TUI handles
      // user input. For now the broker auto-declines after 30s since
      // we don't have the event channel here. The calling code should
      // wire this up via the event stream.
      return this.broker.awaitElicitation();
    };

    this.clients = await McpClientManager.connect(servers, { onElicitation });
    const toolCount = this.clients.getToolDefinitions().length;
    const failures = this.clients.getConnectionFailures();
    this.reloadStatus = {
      ok: failures.length === 0,
      serverCount: servers.length,
      toolCount,
      errors: failures,
      lastUpdatedMs: Date.now(),
    };
    if (toolCount > 0) {
      logger.info(
        { toolCount, serverCount: servers.length, failureCount: failures.length },
        `[mcp] Orchestrator connected — ${toolCount} tool(s) across ${servers.length} server(s)`,
      );
    }
    if (failures.length > 0) {
      // Surface per-server failures so add_mcp_server callers see them
      // instead of getting a silent ok:true. The mcp.ts route logs a
      // matching error after reload() returns.
      for (const failure of failures) {
        logger.error(
          { serverName: failure.serverName, error: failure.error },
          `[mcp] Failed to connect server "${failure.serverName}": ${failure.error}`,
        );
      }
    }
    this.syncOrgan();
  }

  /** Close MCP client connections (call alongside browser cleanup on shutdown). */
  async close(): Promise<void> {
    if (this.clients) {
      logger.debug('[mcp] closeMcp() called — closing MCP connections');
      await this.clients.close().catch(() => {});
      this.clients = null;
    }
  }
}
