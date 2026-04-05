/**
 * MCP Tool Registration Tests
 * Verifies all tool domains register the correct number of tools,
 * error handling works, and cloud tools degrade gracefully.
 */

import { describe, it, expect, vi } from 'vitest';
import { registerCoreTools } from '../tools/core.js';
import { registerCrmTools } from '../tools/crm.js';
import { registerWorkflowTools } from '../tools/workflows.js';
import { registerProjectTools } from '../tools/projects.js';
import { registerKnowledgeTools } from '../tools/knowledge.js';
import { registerResearchTools } from '../tools/research.js';
import { registerMessagingTools } from '../tools/messaging.js';
import { registerCloudTools } from '../tools/cloud.js';
import { registerTools } from '../tools.js';

/* ── Mock MCP Server ─────────────────────────────────────────────── */

interface RegisteredTool {
  name: string;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function createMockServer() {
  const tools: RegisteredTool[] = [];
  const resources: Array<{ name: string }> = [];

  return {
    tools,
    resources,
    tool(name: string, description: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) {
      tools.push({ name, description, handler });
    },
    resource(name: string, _uri: string, _meta: unknown, _handler: unknown) {
      resources.push({ name });
    },
  };
}

/* ── Mock Daemon API Client ──────────────────────────────────────── */

function createMockClient(overrides: {
  getResult?: unknown;
  postResult?: unknown;
  sseResult?: string;
  shouldThrow?: boolean;
} = {}) {
  const { getResult = { data: [] }, postResult = { id: 'test-id' }, sseResult = 'ok', shouldThrow = false } = overrides;

  return {
    get: vi.fn().mockImplementation(async () => {
      if (shouldThrow) throw new Error('Daemon unreachable');
      return getResult;
    }),
    post: vi.fn().mockImplementation(async () => {
      if (shouldThrow) throw new Error('Daemon unreachable');
      return postResult;
    }),
    postSSE: vi.fn().mockImplementation(async () => {
      if (shouldThrow) throw new Error('Daemon unreachable');
      return sseResult;
    }),
  };
}

/* ── Registration count tests ────────────────────────────────────── */

describe('MCP tool registration', () => {
  it('registers 6 core tools', () => {
    const server = createMockServer();
    registerCoreTools(server as never, createMockClient() as never);
    expect(server.tools).toHaveLength(6);
    expect(server.tools.map(t => t.name)).toEqual([
      'ohwow_chat',
      'ohwow_list_agents',
      'ohwow_run_agent',
      'ohwow_get_task',
      'ohwow_list_tasks',
      'ohwow_workspace_status',
    ]);
  });

  it('registers 3 CRM tools', () => {
    const server = createMockServer();
    registerCrmTools(server as never, createMockClient() as never);
    expect(server.tools).toHaveLength(3);
    expect(server.tools.map(t => t.name)).toEqual([
      'ohwow_list_contacts',
      'ohwow_create_contact',
      'ohwow_search_contacts',
    ]);
  });

  it('registers 4 workflow tools', () => {
    const server = createMockServer();
    registerWorkflowTools(server as never, createMockClient() as never);
    expect(server.tools).toHaveLength(4);
    expect(server.tools.map(t => t.name)).toEqual([
      'ohwow_list_workflows',
      'ohwow_run_workflow',
      'ohwow_list_automations',
      'ohwow_run_automation',
    ]);
  });

  it('registers 3 project tools', () => {
    const server = createMockServer();
    registerProjectTools(server as never, createMockClient() as never);
    expect(server.tools).toHaveLength(3);
    expect(server.tools.map(t => t.name)).toEqual([
      'ohwow_list_projects',
      'ohwow_create_project',
      'ohwow_list_goals',
    ]);
  });

  it('registers 3 knowledge tools', () => {
    const server = createMockServer();
    registerKnowledgeTools(server as never, createMockClient() as never);
    expect(server.tools).toHaveLength(3);
  });

  it('registers 2 research tools', () => {
    const server = createMockServer();
    registerResearchTools(server as never, createMockClient() as never);
    expect(server.tools).toHaveLength(2);
  });

  it('registers 2 messaging tools', () => {
    const server = createMockServer();
    registerMessagingTools(server as never, createMockClient() as never);
    expect(server.tools).toHaveLength(2);
  });

  it('registers 2 cloud tools', () => {
    const server = createMockServer();
    registerCloudTools(server as never, createMockClient() as never);
    expect(server.tools).toHaveLength(2);
    expect(server.tools.map(t => t.name)).toEqual([
      'ohwow_list_sites',
      'ohwow_list_integrations',
    ]);
  });

  it('registers all 25 tools via barrel', () => {
    const server = createMockServer();
    registerTools(server as never, createMockClient() as never);
    expect(server.tools).toHaveLength(25);
  });

  it('every tool has a unique name', () => {
    const server = createMockServer();
    registerTools(server as never, createMockClient() as never);
    const names = server.tools.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool name starts with ohwow_', () => {
    const server = createMockServer();
    registerTools(server as never, createMockClient() as never);
    for (const tool of server.tools) {
      expect(tool.name).toMatch(/^ohwow_/);
    }
  });
});

/* ── Error handling tests ────────────────────────────────────────── */

describe('MCP tool error handling', () => {
  it('returns isError when daemon is unreachable (REST tool)', async () => {
    const server = createMockServer();
    const client = createMockClient({ shouldThrow: true });
    registerCrmTools(server as never, client as never);

    const listContacts = server.tools.find(t => t.name === 'ohwow_list_contacts')!;
    const result = await listContacts.handler({}) as { isError: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Daemon unreachable');
  });

  it('returns isError when daemon is unreachable (SSE tool)', async () => {
    const server = createMockServer();
    const client = createMockClient({ shouldThrow: true });
    registerResearchTools(server as never, client as never);

    const research = server.tools.find(t => t.name === 'ohwow_deep_research')!;
    const result = await research.handler({ question: 'test' }) as { isError: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Daemon unreachable');
  });
});

/* ── Cloud tool graceful degradation ─────────────────────────────── */

describe('Cloud tool graceful degradation', () => {
  it('returns friendly message when not connected to cloud', async () => {
    const server = createMockServer();
    const client = createMockClient({ getResult: { cloudConnected: false, data: [] } });
    registerCloudTools(server as never, client as never);

    const listSites = server.tools.find(t => t.name === 'ohwow_list_sites')!;
    const result = await listSites.handler({}) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toContain('ohwow connect');
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  it('returns data when connected to cloud', async () => {
    const sites = [{ id: '1', name: 'My Site', slug: 'my-site' }];
    const server = createMockServer();
    const client = createMockClient({ getResult: { cloudConnected: true, data: sites } });
    registerCloudTools(server as never, client as never);

    const listSites = server.tools.find(t => t.name === 'ohwow_list_sites')!;
    const result = await listSites.handler({}) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(sites);
  });
});
