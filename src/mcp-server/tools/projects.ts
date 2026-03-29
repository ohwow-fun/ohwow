/**
 * Project & Goal MCP Tools
 * Project management and goal tracking.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

export function registerProjectTools(server: McpServer, client: DaemonApiClient): void {
  // ohwow_list_projects — Direct REST
  server.tool(
    'ohwow_list_projects',
    '[Projects] List all projects with status and task counts.',
    {},
    async () => {
      try {
        const data = await client.get('/api/projects') as Record<string, unknown>;
        const projects = data.data || data;
        return { content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // ohwow_create_project — Direct REST
  server.tool(
    'ohwow_create_project',
    '[Projects] Create a new project for organizing work.',
    {
      name: z.string().describe('Project name'),
      description: z.string().optional().describe('Project description'),
    },
    async ({ name, description }) => {
      try {
        const body: Record<string, unknown> = { name };
        if (description) body.description = description;
        const result = await client.post('/api/projects', body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // ohwow_list_goals — Via orchestrator (no direct REST endpoint)
  server.tool(
    'ohwow_list_goals',
    '[Goals] List workspace goals with progress tracking.',
    {},
    async () => {
      try {
        const text = await client.postSSE('/api/chat', {
          message: 'Use the list_goals tool. Return the results as-is.',
        }, 15_000);
        return { content: [{ type: 'text' as const, text: text || 'No goals found' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
