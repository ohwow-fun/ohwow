/**
 * Workflow & Automation MCP Tools
 * List and execute workflows and automations.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

export function registerWorkflowTools(server: McpServer, client: DaemonApiClient): void {
  // ohwow_list_workflows — Direct REST
  server.tool(
    'ohwow_list_workflows',
    '[Workflows] List all workflows in the workspace with their steps and status.',
    {},
    async () => {
      try {
        const data = await client.get('/api/workflows') as Record<string, unknown>;
        const workflows = data.data || data;
        return { content: [{ type: 'text' as const, text: JSON.stringify(workflows, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // ohwow_run_workflow — Via orchestrator (complex execution logic)
  server.tool(
    'ohwow_run_workflow',
    '[Workflows] Execute a workflow by ID. Use ohwow_list_workflows to find workflow IDs.',
    {
      workflowId: z.string().describe('The workflow ID to execute'),
      variables: z.record(z.string(), z.unknown()).optional().describe('Input variables for the workflow'),
    },
    async ({ workflowId, variables }) => {
      try {
        const varStr = variables ? ` with variables: ${JSON.stringify(variables)}` : '';
        const text = await client.postSSE('/api/chat', {
          message: `Use the run_workflow tool with workflowId: "${workflowId}"${varStr}.`,
        }, 60_000);
        return { content: [{ type: 'text' as const, text: text || 'Workflow started' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // ohwow_list_automations — Direct REST
  server.tool(
    'ohwow_list_automations',
    '[Automations] List all automations with their triggers and status.',
    {},
    async () => {
      try {
        const data = await client.get('/api/automations') as Record<string, unknown>;
        const automations = data.data || data;
        return { content: [{ type: 'text' as const, text: JSON.stringify(automations, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // ohwow_run_automation — Direct REST
  server.tool(
    'ohwow_run_automation',
    '[Automations] Manually trigger an automation by ID. Use ohwow_list_automations to find automation IDs.',
    {
      automationId: z.string().describe('The automation ID to trigger'),
    },
    async ({ automationId }) => {
      try {
        const result = await client.post(`/api/automations/${automationId}/execute`, {});
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
