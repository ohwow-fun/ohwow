/**
 * MCP Tool Definitions
 * 6 tools that bridge Claude Code to the ohwow daemon.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from './api-client.js';

export function registerTools(server: McpServer, client: DaemonApiClient): void {
  // 1. ohwow_chat — Primary tool: send message to orchestrator
  server.tool(
    'ohwow_chat',
    'Send a message to the OHWOW orchestrator. It has 100+ internal tools and can run agents, manage tasks, scrape websites, research topics, manage CRM, create workflows, and more. Use this for complex or multi-step requests.',
    { message: z.string().describe('The message or instruction to send to the orchestrator') },
    async ({ message }) => {
      try {
        const text = await client.postSSE('/api/chat', { message });
        return { content: [{ type: 'text' as const, text: text || 'No response from orchestrator' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // 2. ohwow_list_agents — List all agents
  server.tool(
    'ohwow_list_agents',
    'List all agents in the OHWOW workspace with their status, role, and capabilities.',
    {},
    async () => {
      try {
        const data = await client.get('/api/agents') as Record<string, unknown>;
        const agents = data.data || data;
        return { content: [{ type: 'text' as const, text: JSON.stringify(agents, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // 3. ohwow_run_agent — Execute a specific agent
  server.tool(
    'ohwow_run_agent',
    'Execute a specific agent with a prompt. Returns a task ID you can use with ohwow_get_task to check the result.',
    {
      agentId: z.string().describe('The ID of the agent to run'),
      prompt: z.string().describe('The task or instruction for the agent'),
    },
    async ({ agentId, prompt }) => {
      try {
        const result = await client.post('/api/tasks', { agentId, title: prompt });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // 4. ohwow_get_task — Get task status and result
  server.tool(
    'ohwow_get_task',
    'Get the status and result of a task by its ID.',
    { taskId: z.string().describe('The task ID to look up') },
    async ({ taskId }) => {
      try {
        const result = await client.get(`/api/tasks/${taskId}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // 5. ohwow_list_tasks — List recent tasks
  server.tool(
    'ohwow_list_tasks',
    'List recent tasks. Optionally filter by status or agent.',
    {
      status: z.string().optional().describe('Filter by status: pending, running, completed, failed'),
      agentId: z.string().optional().describe('Filter by agent ID'),
      limit: z.number().optional().describe('Max number of tasks to return (default: 20)'),
    },
    async ({ status, agentId, limit }) => {
      try {
        const params = new URLSearchParams();
        if (status) params.set('status', status);
        if (agentId) params.set('agentId', agentId);
        if (limit) params.set('limit', String(limit));
        const query = params.toString();
        const result = await client.get(`/api/tasks${query ? `?${query}` : ''}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // 6. ohwow_workspace_status — Workspace overview
  server.tool(
    'ohwow_workspace_status',
    'Get workspace status: agent count, uptime, tier, and system stats.',
    {},
    async () => {
      try {
        const result = await client.get('/api/dashboard/init');
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
