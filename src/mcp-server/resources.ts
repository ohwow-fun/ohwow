/**
 * MCP Resource Definitions
 * Provides auto-context to Claude Code about the workspace.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from './api-client.js';

export function registerResources(server: McpServer, client: DaemonApiClient): void {
  // Agents resource — lists all agents with descriptions
  server.resource(
    'agents',
    'ohwow://agents',
    { description: 'All OHWOW agents with their descriptions, roles, and available tools' },
    async () => {
      try {
        const data = await client.get('/api/agents') as Record<string, unknown>;
        const agents = data.data || data;
        return {
          contents: [{
            uri: 'ohwow://agents',
            mimeType: 'application/json',
            text: JSON.stringify(agents, null, 2),
          }],
        };
      } catch {
        return {
          contents: [{
            uri: 'ohwow://agents',
            mimeType: 'text/plain',
            text: 'Could not load agents. Is the OHWOW daemon running?',
          }],
        };
      }
    },
  );

  // Workspace resource — workspace status and configuration
  server.resource(
    'workspace',
    'ohwow://workspace',
    { description: 'OHWOW workspace status: tier, uptime, agent count, system stats' },
    async () => {
      try {
        const data = await client.get('/api/dashboard/init');
        return {
          contents: [{
            uri: 'ohwow://workspace',
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          }],
        };
      } catch {
        return {
          contents: [{
            uri: 'ohwow://workspace',
            mimeType: 'text/plain',
            text: 'Could not load workspace status. Is the OHWOW daemon running?',
          }],
        };
      }
    },
  );
}
