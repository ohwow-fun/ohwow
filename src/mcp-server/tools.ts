/**
 * MCP Tool Registration Barrel
 * Imports and registers all domain-specific tool sets.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from './api-client.js';
import { registerCoreTools } from './tools/core.js';
import { registerCrmTools } from './tools/crm.js';
import { registerWorkflowTools } from './tools/workflows.js';
import { registerProjectTools } from './tools/projects.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerResearchTools } from './tools/research.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerCloudTools } from './tools/cloud.js';
import { registerDaemonTools } from './tools/daemon.js';
import { registerWorkspaceTools } from './tools/workspace.js';
import { registerMcpServerTools } from './tools/mcp-servers.js';
import { registerAgentManagementTools } from './tools/agents.js';
import { registerPermissionRequestTools } from './tools/permission-requests.js';

export function registerTools(server: McpServer, client: DaemonApiClient): void {
  registerCoreTools(server, client);
  registerCrmTools(server, client);
  registerWorkflowTools(server, client);
  registerProjectTools(server, client);
  registerKnowledgeTools(server, client);
  registerResearchTools(server, client);
  registerMessagingTools(server, client);
  registerCloudTools(server, client);
  registerDaemonTools(server);
  registerWorkspaceTools(server, client);
  registerMcpServerTools(server, client);
  registerAgentManagementTools(server, client);
  registerPermissionRequestTools(server, client);
}
