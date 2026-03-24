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

  // Contacts resource — recent contacts and pipeline summary
  server.resource(
    'contacts',
    'ohwow://contacts',
    { description: 'Recent CRM contacts with pipeline stage breakdown' },
    async () => {
      try {
        const data = await client.get('/api/contacts?limit=10') as Record<string, unknown>;
        const contacts = data.data || data;
        return {
          contents: [{
            uri: 'ohwow://contacts',
            mimeType: 'application/json',
            text: JSON.stringify(contacts, null, 2),
          }],
        };
      } catch {
        return {
          contents: [{
            uri: 'ohwow://contacts',
            mimeType: 'text/plain',
            text: 'Could not load contacts. Is the OHWOW daemon running?',
          }],
        };
      }
    },
  );

  // Projects resource — active projects with task counts
  server.resource(
    'projects',
    'ohwow://projects',
    { description: 'Active projects with task counts and status' },
    async () => {
      try {
        const data = await client.get('/api/projects') as Record<string, unknown>;
        const projects = data.data || data;
        return {
          contents: [{
            uri: 'ohwow://projects',
            mimeType: 'application/json',
            text: JSON.stringify(projects, null, 2),
          }],
        };
      } catch {
        return {
          contents: [{
            uri: 'ohwow://projects',
            mimeType: 'text/plain',
            text: 'Could not load projects. Is the OHWOW daemon running?',
          }],
        };
      }
    },
  );

  // Workflows resource — workflow and automation catalog
  server.resource(
    'workflows',
    'ohwow://workflows',
    { description: 'Workflow and automation catalog with descriptions and trigger types' },
    async () => {
      try {
        const [wfData, autoData] = await Promise.all([
          client.get('/api/workflows') as Promise<Record<string, unknown>>,
          client.get('/api/automations') as Promise<Record<string, unknown>>,
        ]);
        const workflows = wfData.data || wfData;
        const automations = autoData.data || autoData;
        return {
          contents: [{
            uri: 'ohwow://workflows',
            mimeType: 'application/json',
            text: JSON.stringify({ workflows, automations }, null, 2),
          }],
        };
      } catch {
        return {
          contents: [{
            uri: 'ohwow://workflows',
            mimeType: 'text/plain',
            text: 'Could not load workflows. Is the OHWOW daemon running?',
          }],
        };
      }
    },
  );

  // Capabilities resource — static tool manifest (no API call)
  server.resource(
    'capabilities',
    'ohwow://capabilities',
    { description: 'Complete list of all OHWOW MCP tools grouped by domain' },
    async () => ({
      contents: [{
        uri: 'ohwow://capabilities',
        mimeType: 'text/plain',
        text: CAPABILITIES_MANIFEST,
      }],
    }),
  );
}

const CAPABILITIES_MANIFEST = `OHWOW MCP Plugin — Tool Reference

CORE
  ohwow_chat              Send free-form messages to the orchestrator (88+ internal tools)
  ohwow_list_agents       List all agents with status and capabilities
  ohwow_run_agent         Execute an agent with a prompt (returns task ID)
  ohwow_get_task          Get task status and result by ID
  ohwow_list_tasks        List recent tasks with optional filters
  ohwow_workspace_status  Workspace overview: agents, uptime, tier, stats

CRM
  ohwow_list_contacts     List contacts (filterable by name/email/company)
  ohwow_create_contact    Add a new contact to the CRM
  ohwow_search_contacts   Full-text search across all contacts

WORKFLOWS & AUTOMATIONS
  ohwow_list_workflows    List all workflows
  ohwow_run_workflow      Execute a workflow by ID
  ohwow_list_automations  List all automations with triggers
  ohwow_run_automation    Manually trigger an automation

PROJECTS & GOALS
  ohwow_list_projects     List projects with task counts
  ohwow_create_project    Create a new project
  ohwow_list_goals        List goals with progress tracking

KNOWLEDGE BASE
  ohwow_list_knowledge    List all knowledge documents
  ohwow_search_knowledge  Semantic search across the knowledge base
  ohwow_add_knowledge_url Add a web page to the knowledge base

RESEARCH
  ohwow_deep_research     Multi-source web research with synthesis
  ohwow_scrape_url        Scrape a web page for structured content

MESSAGING
  ohwow_send_message      Send a message via WhatsApp or Telegram
  ohwow_list_chats        List connected chats for a channel

CLOUD (requires ohwow.fun connection)
  ohwow_list_sites        List sites on the cloud dashboard
  ohwow_list_integrations List connected third-party integrations

For anything not listed above, use ohwow_chat to access the full orchestrator.
`;
