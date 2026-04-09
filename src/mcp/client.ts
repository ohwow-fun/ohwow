/**
 * MCP Client Manager
 * Manages connections to one or more MCP servers.
 * Supports stdio (subprocess) and HTTP (Streamable HTTP) transports.
 * Supports OAuth 2.1, Bearer, and API key authentication for HTTP servers.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { McpServerConfig, McpToolAnnotations } from './types.js';
import { mcpToolToAnthropic, parseMcpToolName, extractToolAnnotations } from './tool-adapter.js';
import { logger } from '../lib/logger.js';

export interface McpToolEntry {
  client: Client;
  serverName: string;
  originalName: string;
  annotations?: McpToolAnnotations;
}

/** A media attachment extracted from an MCP tool result. */
export interface MediaAttachment {
  type: 'image' | 'video' | 'audio';
  mimeType: string;
  /** Base64-encoded data (present when MCP server returns inline content). */
  data?: string;
  /** URL to download from (present when MCP server returns a link). */
  url?: string;
}

/** Full result from an MCP tool call, including any media attachments. */
export interface McpToolCallResult {
  content: string;
  is_error?: boolean;
  structuredContent?: unknown;
  /** Media files returned by the tool (images, video, audio). */
  mediaAttachments?: MediaAttachment[];
}

/**
 * Callback for handling MCP elicitation requests (server asks user for input).
 * Return the user's response fields, or null to decline the elicitation.
 */
export type ElicitationHandler = (
  serverName: string,
  message: string,
  schema: Record<string, unknown>,
) => Promise<Record<string, unknown> | null>;

export interface McpClientManagerOptions {
  onElicitation?: ElicitationHandler;
}

export class McpClientManager {
  private clients: Map<string, Client> = new Map();
  private toolMap: Map<string, McpToolEntry> = new Map();
  private toolDefinitions: Tool[] = [];
  private elicitationHandler?: ElicitationHandler;
  private serverConfigs: Map<string, McpServerConfig> = new Map();
  private connectionFailures: Array<{ serverName: string; error: string }> = [];

  private constructor(opts?: McpClientManagerOptions) {
    this.elicitationHandler = opts?.onElicitation;
  }

  /**
   * Connect to all configured MCP servers.
   * Servers that fail to connect are skipped with a warning — they don't abort the whole task.
   */
  static async connect(servers: McpServerConfig[], opts?: McpClientManagerOptions): Promise<McpClientManager> {
    const manager = new McpClientManager(opts);

    for (const server of servers) {
      try {
        await manager.connectServer(server);
      } catch (err) {
        manager.connectionFailures.push({
          serverName: server.name,
          error: err instanceof Error ? err.message : String(err),
        });
        logger.warn(
          `[MCP] Couldn't connect to server "${server.name}": ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return manager;
  }

  private async connectServer(server: McpServerConfig): Promise<void> {
    const clientOpts = this.elicitationHandler
      ? { capabilities: { elicitation: { form: {} } } }
      : {};
    const client = new Client({ name: 'ohwow', version: '1.0' }, clientOpts);

    // Register elicitation handler if provided
    if (this.elicitationHandler) {
      const handler = this.elicitationHandler;
      const serverName = server.name;
      (client as { setRequestHandler(schema: unknown, handler: (request: unknown) => Promise<unknown>): void }).setRequestHandler(
        { method: 'elicitation/create' },
        async (request: unknown) => {
          const req = request as { params: { message?: string; requestedSchema?: Record<string, unknown> } };
          const message = req.params.message || 'The server is requesting additional information.';
          const schema = req.params.requestedSchema || {};
          const result = await handler(serverName, message, schema);
          if (result === null) {
            return { action: 'decline' as const };
          }
          return { action: 'accept' as const, content: result };
        },
      );
    }

    const connectWithTimeout = (promise: Promise<void>, label: string): Promise<void> =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`MCP connection to "${label}" timed out after 30s`)), 30_000),
        ),
      ]);

    if (server.transport === 'stdio') {
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: server.env ? { ...process.env, ...server.env } as Record<string, string> : undefined,
      });
      await connectWithTimeout(client.connect(transport), server.name);
    } else if (server.transport === 'http') {
      const headers: Record<string, string> = { ...server.headers };

      if (server.auth) {
        const authHeader = await this.resolveAuthHeader(server);
        if (authHeader) {
          headers['Authorization'] = authHeader;
        }
      }

      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      });
      await connectWithTimeout(client.connect(transport), server.name);
    } else {
      throw new Error(`Unknown MCP transport: ${(server as McpServerConfig).transport}`);
    }

    // List tools from this server
    const { tools } = await client.listTools();
    this.clients.set(server.name, client);
    this.serverConfigs.set(server.name, server);

    for (const tool of tools) {
      const namespacedName = `mcp__${server.name}__${tool.name}`;
      const annotations = extractToolAnnotations(tool);
      this.toolMap.set(namespacedName, {
        client,
        serverName: server.name,
        originalName: tool.name,
        annotations,
      });
      this.toolDefinitions.push(mcpToolToAnthropic(server.name, tool));
    }

    logger.info(`[MCP] Connected to "${server.name}" — ${tools.length} tool(s)`);
  }

  /**
   * Resolve the Authorization header value for an HTTP server with auth config.
   */
  private async resolveAuthHeader(server: Extract<McpServerConfig, { transport: 'http' }>): Promise<string | null> {
    const auth = server.auth;
    if (!auth) return null;

    switch (auth.type) {
      case 'bearer':
        return `Bearer ${auth.token}`;

      case 'api_key':
        // If a custom header is specified, we handle it differently in connectServer
        // For the default case, use Authorization header
        if (auth.header && auth.header.toLowerCase() !== 'authorization') {
          return null; // handled via custom headers
        }
        return `Bearer ${auth.key}`;

      case 'oauth2': {
        return this.fetchOAuth2Token(auth);
      }

      default:
        return null;
    }
  }

  /**
   * Fetch an OAuth 2.0 access token using client credentials grant.
   */
  private async fetchOAuth2Token(auth: Extract<import('./types.js').McpAuthConfig, { type: 'oauth2' }>): Promise<string | null> {
    try {
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
      });
      if (auth.scopes?.length) {
        params.set('scope', auth.scopes.join(' '));
      }

      const response = await fetch(auth.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!response.ok) {
        logger.warn(`[MCP] OAuth token request failed: ${response.status} ${response.statusText}`);
        return null;
      }

      const data = await response.json() as { access_token?: string; token_type?: string };
      if (!data.access_token) {
        logger.warn('[MCP] OAuth response missing access_token');
        return null;
      }

      return `Bearer ${data.access_token}`;
    } catch (err) {
      logger.warn(`[MCP] OAuth token fetch error: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Returns all MCP tools in Anthropic Tool format. */
  getToolDefinitions(): Tool[] {
    return this.toolDefinitions;
  }

  /** Check whether any MCP tools are available. */
  hasTools(): boolean {
    return this.toolDefinitions.length > 0;
  }

  /** Check whether a namespaced tool name belongs to a connected MCP server. */
  hasTool(name: string): boolean {
    return this.toolMap.has(name);
  }

  /** Get the tool entry for a namespaced tool name. */
  getToolEntry(name: string): McpToolEntry | undefined {
    return this.toolMap.get(name);
  }

  /** Get annotations for a namespaced tool name. */
  getToolAnnotations(name: string): McpToolAnnotations | undefined {
    return this.toolMap.get(name)?.annotations;
  }

  /** Call an MCP tool by its namespaced name. */
  async callTool(
    namespacedName: string,
    input: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    const entry = this.toolMap.get(namespacedName);
    if (!entry) {
      const parsed = parseMcpToolName(namespacedName);
      const serverName = parsed?.serverName ?? namespacedName;
      return {
        content: `Error: MCP tool "${namespacedName}" not found. Server "${serverName}" may not be connected.`,
        is_error: true,
      };
    }

    try {
      const result = await entry.client.callTool({ name: entry.originalName, arguments: input });

      // Handle structured content if present
      const structuredContent = (result as Record<string, unknown>).structuredContent;

      // Convert MCP content array to a string, extracting media attachments
      const contentBlocks = result.content as Array<Record<string, unknown>>;
      const parts: string[] = [];
      const mediaAttachments: MediaAttachment[] = [];

      for (const block of contentBlocks) {
        if (block['type'] === 'text') {
          parts.push(String(block['text'] ?? ''));
        } else if (block['type'] === 'image') {
          const mimeType = String(block['mimeType'] ?? 'image/png');
          const data = String(block['data'] ?? '');
          if (data) {
            mediaAttachments.push({ type: 'image', mimeType, data });
            parts.push(`[Generated image: ${mimeType}]`);
          } else {
            parts.push(`[Image: ${mimeType}]`);
          }
        } else if (block['type'] === 'audio') {
          const mimeType = String(block['mimeType'] ?? 'audio/mpeg');
          const data = String(block['data'] ?? '');
          if (data) {
            mediaAttachments.push({ type: 'audio', mimeType, data });
            parts.push(`[Generated audio: ${mimeType}]`);
          } else {
            parts.push(`[Audio: ${mimeType}]`);
          }
        } else if (block['type'] === 'resource') {
          const resource = block['resource'] as Record<string, unknown> | undefined;
          if (resource?.['text']) {
            parts.push(String(resource['text']));
          } else if (resource?.['blob']) {
            // Resource with binary data (some MCP servers return media this way)
            const mimeType = String(resource['mimeType'] ?? 'application/octet-stream');
            const data = String(resource['blob']);
            const mediaType = mimeType.startsWith('video/') ? 'video' as const
              : mimeType.startsWith('audio/') ? 'audio' as const
              : 'image' as const;
            mediaAttachments.push({ type: mediaType, mimeType, data });
            parts.push(`[Generated ${mediaType}: ${mimeType}]`);
          } else {
            parts.push(JSON.stringify(block));
          }
        } else {
          parts.push(JSON.stringify(block));
        }
      }

      // Check for URL-based results (some MCP servers return URLs instead of base64)
      for (const part of parts) {
        const urlMatch = part.match(/https?:\/\/[^\s"]+\.(png|jpg|jpeg|webp|gif|mp4|webm|mp3|wav)/i);
        if (urlMatch && mediaAttachments.length === 0) {
          const ext = urlMatch[1].toLowerCase();
          const mediaType = ['mp4', 'webm'].includes(ext) ? 'video' as const
            : ['mp3', 'wav'].includes(ext) ? 'audio' as const
            : 'image' as const;
          mediaAttachments.push({
            type: mediaType,
            mimeType: `${mediaType}/${ext === 'jpg' ? 'jpeg' : ext}`,
            url: urlMatch[0],
          });
        }
      }

      return {
        content: parts.join('\n') || '(no output)',
        is_error: result.isError === true,
        structuredContent,
        mediaAttachments: mediaAttachments.length > 0 ? mediaAttachments : undefined,
      };
    } catch (err) {
      return {
        content: `Error: ${err instanceof Error ? err.message : 'MCP tool call failed'}`,
        is_error: true,
      };
    }
  }

  /** Returns servers that failed to connect during initialization. */
  getConnectionFailures(): Array<{ serverName: string; error: string }> {
    return this.connectionFailures;
  }

  /** Attempt to reconnect a server identified by a namespaced tool name. */
  async reconnectServer(namespacedToolName: string): Promise<boolean> {
    const parsed = parseMcpToolName(namespacedToolName);
    if (!parsed) return false;

    const config = this.serverConfigs.get(parsed.serverName);
    if (!config) return false;

    // Close existing client
    const existing = this.clients.get(parsed.serverName);
    if (existing) {
      try { await existing.close(); } catch { /* ignore */ }
      this.clients.delete(parsed.serverName);
    }

    // Remove stale tool entries
    for (const [key, entry] of this.toolMap) {
      if (entry.serverName === parsed.serverName) {
        this.toolMap.delete(key);
      }
    }
    this.toolDefinitions = this.toolDefinitions.filter(
      t => !t.name.startsWith(`mcp__${parsed.serverName}__`)
    );

    // Reconnect
    try {
      await this.connectServer(config);
      logger.info(`[MCP] Reconnected to "${parsed.serverName}"`);
      return true;
    } catch (err) {
      logger.warn(`[MCP] Reconnection to "${parsed.serverName}" failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** Close all client connections and terminate subprocess transports. */
  async close(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.close();
      } catch (err) {
        logger.warn(`[MCP] Error closing client "${name}": ${err instanceof Error ? err.message : err}`);
      }
    }
    this.clients.clear();
    this.toolMap.clear();
    this.toolDefinitions = [];
  }
}
