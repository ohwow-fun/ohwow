/**
 * Cloud Dashboard MCP Tools
 * Sites and integrations from ohwow.fun (proxied via daemon).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

export function registerCloudTools(server: McpServer, client: DaemonApiClient): void {
  // ohwow_list_sites — Cloud sites via daemon proxy
  server.tool(
    'ohwow_list_sites',
    '[Cloud] List all sites on the ohwow.fun cloud dashboard with status and URLs. Requires cloud connection.',
    {},
    async () => {
      try {
        const result = await client.get('/api/cloud/sites') as Record<string, unknown>;
        if (result.cloudConnected === false) {
          return { content: [{ type: 'text' as const, text: 'Not connected to ohwow.fun. Run `ohwow connect` to link your cloud account.' }] };
        }
        const data = result.data || [];
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // ohwow_list_integrations — Cloud integrations via daemon proxy
  server.tool(
    'ohwow_list_integrations',
    '[Cloud] List connected integrations (Gmail, GitHub, Stripe, etc.) and their status. Requires cloud connection.',
    {},
    async () => {
      try {
        const result = await client.get('/api/cloud/integrations') as Record<string, unknown>;
        if (result.cloudConnected === false) {
          return { content: [{ type: 'text' as const, text: 'Not connected to ohwow.fun. Run `ohwow connect` to link your cloud account.' }] };
        }
        const data = result.data || [];
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
