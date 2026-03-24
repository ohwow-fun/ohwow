/**
 * OHWOW MCP Server
 * Exposes the ohwow daemon to Claude Code via the Model Context Protocol.
 * Runs as a stdio transport child process spawned by Claude Code.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DaemonApiClient } from './api-client.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { VERSION } from '../version.js';

export async function startMcpServer(): Promise<void> {
  let client: DaemonApiClient;

  try {
    client = await DaemonApiClient.create();
  } catch (err) {
    process.stderr.write(`[ohwow-mcp] ${err instanceof Error ? err.message : 'Unknown error'}\n`);
    process.exit(1);
  }

  const server = new McpServer({
    name: 'ohwow',
    version: VERSION,
  });

  registerTools(server, client);
  registerResources(server, client);

  const transport = new StdioServerTransport();

  // Graceful shutdown on signals
  const shutdown = async () => {
    try {
      await server.close();
    } catch {
      // Best-effort cleanup
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    await server.connect(transport);
    process.stderr.write(`[ohwow-mcp] Connected (v${VERSION})\n`);
  } catch (err) {
    process.stderr.write(`[ohwow-mcp] Failed to connect: ${err instanceof Error ? err.message : 'Unknown error'}\n`);
    process.exit(1);
  }
}
