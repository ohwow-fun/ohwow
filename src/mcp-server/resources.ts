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

const CAPABILITIES_MANIFEST = `OHWOW MCP Plugin — Quick Reference

GETTING STARTED
  1. ohwow_workspace_status    Check connection and workspace overview
  2. ohwow_list_agents         See available AI agents
  3. ohwow_run_agent           Run an agent (returns task ID)
  4. ohwow_get_task            Poll for task result

CORE (instant)
  ohwow_chat              Orchestrator: desktop control, scheduling, approvals, A2A, PDF, and 80+ more
  ohwow_list_agents       List all agents
  ohwow_run_agent         Run agent (async; poll with ohwow_get_task)
  ohwow_get_task          Check task status and result
  ohwow_list_tasks        Recent tasks with filters
  ohwow_workspace_status  Agent count, uptime, tier

CRM (instant)
  ohwow_list_contacts     List/filter contacts
  ohwow_create_contact    Add contact
  ohwow_search_contacts   Full-text search (~5s)

WORKFLOWS (instant unless noted)
  ohwow_list_workflows    List workflows
  ohwow_run_workflow      Run workflow (~10-60s)
  ohwow_list_automations  List automations
  ohwow_run_automation    Trigger automation

PROJECTS (instant)
  ohwow_list_projects     List projects
  ohwow_create_project    Create project
  ohwow_list_goals        List goals (~5s)

KNOWLEDGE (~5-30s, list/get instant)
  ohwow_list_knowledge    List documents. Pass include_bodies=true for full text (~50ms direct)
  ohwow_get_knowledge     Fetch one document by id with full compiled body (~50ms direct)
  ohwow_search_knowledge  Semantic search
  ohwow_add_knowledge_url Ingest web page

EMBEDDINGS (sub-second warm; ~30s on first call if daemon just started)
  ohwow_embed             Encode 1-256 texts into 1024-dim L2-normalized vectors (in-daemon Qwen3)

RESEARCH (slow)
  ohwow_deep_research     Web research (30-120s depending on depth)
  ohwow_scrape_url        Scrape page (~10s)

MESSAGING (~5s)
  ohwow_send_message      Send WhatsApp/Telegram (channel must be connected)
  ohwow_list_chats        List connected chats

CLOUD (instant, requires ohwow.fun)
  ohwow_list_sites        Cloud sites
  ohwow_list_integrations Connected services

USE ohwow_chat FOR: desktop control, scheduling, agent state, approvals,
A2A protocol, PDF forms, media generation, automation creation, and
anything not listed above.
`;
