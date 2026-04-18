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
import { registerMcpServerTools } from '../tools/mcp-servers.js';
import { registerAgentManagementTools } from '../tools/agents.js';
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
    del: vi.fn().mockImplementation(async () => {
      if (shouldThrow) throw new Error('Daemon unreachable');
      return postResult;
    }),
    patch: vi.fn().mockImplementation(async () => {
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
  it('registers 8 core tools', () => {
    const server = createMockServer();
    registerCoreTools(server as never, createMockClient() as never);
    expect(server.tools).toHaveLength(8);
    expect(server.tools.map(t => t.name)).toEqual([
      'ohwow_chat',
      'ohwow_get_chat',
      'ohwow_list_agents',
      'ohwow_run_agent',
      'ohwow_get_task',
      'ohwow_list_tasks',
      'ohwow_workspace_status',
      'ohwow_llm',
    ]);
  });

  it('registers 4 CRM tools', () => {
    const server = createMockServer();
    registerCrmTools(server as never, createMockClient() as never);
    expect(server.tools).toHaveLength(4);
    expect(server.tools.map(t => t.name)).toEqual([
      'ohwow_list_contacts',
      'ohwow_get_contact',
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
    expect(server.tools).toHaveLength(3);
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

  it('registers 4 MCP server management tools', () => {
    const server = createMockServer();
    registerMcpServerTools(server as never, createMockClient() as never);
    expect(server.tools).toHaveLength(4);
    expect(server.tools.map(t => t.name)).toEqual([
      'ohwow_add_mcp_server',
      'ohwow_list_mcp_servers',
      'ohwow_remove_mcp_server',
      'ohwow_test_mcp_server',
    ]);
  });

  it('registers 7 agent management tools', () => {
    const server = createMockServer();
    registerAgentManagementTools(server as never, createMockClient() as never);
    expect(server.tools).toHaveLength(7);
    expect(server.tools.map(t => t.name)).toEqual([
      'ohwow_create_agent',
      'ohwow_get_agent',
      'ohwow_update_agent',
      'ohwow_grant_agent_path',
      'ohwow_list_agent_paths',
      'ohwow_revoke_agent_path',
      'ohwow_delete_agent',
    ]);
  });

  it('registers all tools via barrel', () => {
    const server = createMockServer();
    registerTools(server as never, createMockClient() as never);
    // 87 existing + 3 reply-draft tools (list/approve/reject x_reply_draft).
    expect(server.tools).toHaveLength(90);
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

/* ── MCP server tool security ────────────────────────────────────── */

describe('MCP server management tools', () => {
  it('ohwow_add_mcp_server forwards headers to the daemon POST body', async () => {
    const server = createMockServer();
    const client = createMockClient({
      postResult: { ok: true, server: { name: 'acme', transport: 'http', url: 'https://acme.example/api/mcp' } },
    });
    registerMcpServerTools(server as never, client as never);

    const addTool = server.tools.find(t => t.name === 'ohwow_add_mcp_server')!;
    await addTool.handler({
      name: 'acme',
      transport: 'http',
      url: 'https://acme.example/api/mcp',
      headers: { Authorization: 'Bearer sk-super-secret-123' },
    });

    // The client.post call should have received the credential in its body
    // (that's how it gets forwarded to the daemon), but the add tool's
    // RESPONSE must not echo it back.
    const postCall = (client.post as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(postCall[0]).toBe('/api/mcp/servers');
    expect(JSON.stringify(postCall[1])).toContain('Bearer sk-super-secret-123');
  });

  it('ohwow_add_mcp_server response never echoes the raw credential', async () => {
    const server = createMockServer();
    const client = createMockClient({
      // Simulate the daemon returning a redacted summary (what the real
      // route in src/api/routes/mcp.ts does).
      postResult: {
        ok: true,
        server: {
          name: 'acme',
          transport: 'http',
          url: 'https://acme.example/api/mcp',
          headers: { Authorization: '<set>' },
          enabled: true,
        },
      },
    });
    registerMcpServerTools(server as never, client as never);

    const addTool = server.tools.find(t => t.name === 'ohwow_add_mcp_server')!;
    const result = await addTool.handler({
      name: 'acme',
      transport: 'http',
      url: 'https://acme.example/api/mcp',
      headers: { Authorization: 'Bearer sk-super-secret-123' },
    }) as { content: Array<{ text: string }> };

    const responseText = result.content[0].text;
    expect(responseText).not.toContain('sk-super-secret-123');
    expect(responseText).toContain('<set>');
  });

  it('ohwow_list_mcp_servers passes through redacted daemon response', async () => {
    const server = createMockServer();
    const client = createMockClient({
      getResult: {
        servers: [
          {
            name: 'acme',
            transport: 'http',
            url: 'https://acme.example/api/mcp',
            headers: { Authorization: '<set>' },
            enabled: true,
          },
        ],
      },
    });
    registerMcpServerTools(server as never, client as never);

    const listTool = server.tools.find(t => t.name === 'ohwow_list_mcp_servers')!;
    const result = await listTool.handler({}) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toContain('<set>');
    expect(result.content[0].text).not.toContain('Bearer ');
  });

  it('ohwow_remove_mcp_server calls DELETE on the name path', async () => {
    const server = createMockServer();
    const client = createMockClient({ postResult: { ok: true, removed: 'acme' } });
    registerMcpServerTools(server as never, client as never);

    const removeTool = server.tools.find(t => t.name === 'ohwow_remove_mcp_server')!;
    await removeTool.handler({ name: 'acme' });

    const delCall = (client.del as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(delCall[0]).toBe('/api/mcp/servers/acme');
  });

  it('ohwow_test_mcp_server returns tool names only', async () => {
    const server = createMockServer();
    const client = createMockClient({
      postResult: {
        success: true,
        toolCount: 2,
        toolNames: ['acme_list', 'acme_create'],
        latencyMs: 42,
      },
    });
    registerMcpServerTools(server as never, client as never);

    const testTool = server.tools.find(t => t.name === 'ohwow_test_mcp_server')!;
    const result = await testTool.handler({ name: 'acme' }) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.toolNames).toEqual(['acme_list', 'acme_create']);
    expect(parsed.toolCount).toBe(2);
  });

  it('ohwow_test_mcp_server surfaces connection failures as isError', async () => {
    const server = createMockServer();
    const client = createMockClient({
      postResult: { success: false, error: 'Connection refused', latencyMs: 10 },
    });
    registerMcpServerTools(server as never, client as never);

    const testTool = server.tools.find(t => t.name === 'ohwow_test_mcp_server')!;
    const result = await testTool.handler({ name: 'acme' }) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Connection refused');
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

/* ── Agent management tools ──────────────────────────────────────── */

describe('Agent management tools', () => {
  it('ohwow_create_agent forwards name, system_prompt, and allowlist to POST body', async () => {
    const server = createMockServer();
    const client = createMockClient({
      postResult: {
        data: {
          id: 'uuid-1',
          name: 'daily-standup',
          system_prompt: 'You are a standup agent.',
        },
      },
    });
    registerAgentManagementTools(server as never, client as never);

    const createTool = server.tools.find(t => t.name === 'ohwow_create_agent')!;
    await createTool.handler({
      name: 'daily-standup',
      displayName: 'Daily Standup',
      description: 'Read-only digest agent',
      systemPrompt: 'You are a standup agent.',
      toolAllowlist: ['list_tasks', 'mcp__avenued__list_users'],
      role: 'analyst',
    });

    const postCall = (client.post as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(postCall[0]).toBe('/api/agents');
    const body = postCall[1] as Record<string, unknown>;
    expect(body.name).toBe('daily-standup');
    expect(body.system_prompt).toBe('You are a standup agent.');
    expect(body.display_name).toBe('Daily Standup');
    expect(body.role).toBe('analyst');
    const config = body.config as Record<string, unknown>;
    expect(config.tools_mode).toBe('allowlist');
    expect(config.tools_enabled).toEqual(['list_tasks', 'mcp__avenued__list_users']);
  });

  it('ohwow_create_agent surfaces daemon errors as isError', async () => {
    const server = createMockServer();
    const client = createMockClient({
      postResult: { error: 'An agent named "daily-standup" already exists in this workspace.' },
    });
    registerAgentManagementTools(server as never, client as never);

    const createTool = server.tools.find(t => t.name === 'ohwow_create_agent')!;
    const result = await createTool.handler({
      name: 'daily-standup',
      systemPrompt: 'You are a standup agent.',
    }) as { isError: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('ohwow_get_agent resolves name → id and returns the full row', async () => {
    const agentRow = {
      id: 'uuid-1',
      name: 'daily-standup',
      system_prompt: 'You are a standup agent.',
      config: '{"tools_mode":"allowlist","tools_enabled":["list_tasks"]}',
    };
    const server = createMockServer();
    const client = createMockClient();
    (client.get as unknown as { mockImplementation: (fn: (path: string) => Promise<unknown>) => void })
      .mockImplementation(async (path: string) => {
        if (path === '/api/agents') return { data: [agentRow] };
        if (path === '/api/agents/uuid-1') return { data: agentRow };
        throw new Error(`unexpected path: ${path}`);
      });
    registerAgentManagementTools(server as never, client as never);

    const getTool = server.tools.find(t => t.name === 'ohwow_get_agent')!;
    const result = await getTool.handler({ name: 'daily-standup' }) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.agent.id).toBe('uuid-1');
    expect(parsed.agent.system_prompt).toBe('You are a standup agent.');
  });

  it('ohwow_get_agent returns isError when no agent matches the name', async () => {
    const server = createMockServer();
    const client = createMockClient({ getResult: { data: [] } });
    registerAgentManagementTools(server as never, client as never);

    const getTool = server.tools.find(t => t.name === 'ohwow_get_agent')!;
    const result = await getTool.handler({ name: 'missing' }) as { isError: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No agent named "missing"');
  });

  it('ohwow_get_agent requires either name or id', async () => {
    const server = createMockServer();
    const client = createMockClient();
    registerAgentManagementTools(server as never, client as never);

    const getTool = server.tools.find(t => t.name === 'ohwow_get_agent')!;
    const result = await getTool.handler({}) as { isError: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Provide either');
  });

  it('ohwow_update_agent PATCHes the resolved id with renamed fields', async () => {
    const server = createMockServer();
    const client = createMockClient();
    (client.get as unknown as { mockImplementation: (fn: (path: string) => Promise<unknown>) => void })
      .mockImplementation(async (path: string) => {
        if (path === '/api/agents') return { data: [{ id: 'uuid-1', name: 'daily-standup' }] };
        throw new Error(`unexpected path: ${path}`);
      });
    (client.patch as unknown as { mockImplementation: (fn: (path: string, body: unknown) => Promise<unknown>) => void })
      .mockImplementation(async () => ({ data: { id: 'uuid-1', name: 'daily-standup' } }));
    registerAgentManagementTools(server as never, client as never);

    const updateTool = server.tools.find(t => t.name === 'ohwow_update_agent')!;
    await updateTool.handler({
      name: 'daily-standup',
      systemPrompt: 'Updated prompt.',
      toolAllowlist: ['list_tasks'],
      enabled: false,
    });

    const patchCall = (client.patch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(patchCall[0]).toBe('/api/agents/uuid-1');
    const body = patchCall[1] as Record<string, unknown>;
    expect(body.system_prompt).toBe('Updated prompt.');
    expect(body.enabled).toBe(false);
    const config = body.config as Record<string, unknown>;
    expect(config.tools_enabled).toEqual(['list_tasks']);
    expect(config.tools_mode).toBe('allowlist');
  });

  it('ohwow_update_agent errors if no fields to update', async () => {
    const server = createMockServer();
    const client = createMockClient();
    (client.get as unknown as { mockImplementation: (fn: (path: string) => Promise<unknown>) => void })
      .mockImplementation(async () => ({ data: [{ id: 'uuid-1', name: 'daily-standup' }] }));
    registerAgentManagementTools(server as never, client as never);

    const updateTool = server.tools.find(t => t.name === 'ohwow_update_agent')!;
    const result = await updateTool.handler({ name: 'daily-standup' }) as { isError: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No fields provided');
  });

  it('ohwow_delete_agent resolves name → id and DELETEs', async () => {
    const server = createMockServer();
    const client = createMockClient({
      getResult: { data: [{ id: 'uuid-1', name: 'daily-standup' }] },
      postResult: { data: { deleted: true } },
    });
    registerAgentManagementTools(server as never, client as never);

    const deleteTool = server.tools.find(t => t.name === 'ohwow_delete_agent')!;
    const result = await deleteTool.handler({ name: 'daily-standup' }) as { content: Array<{ text: string }> };

    const delCall = (client.del as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(delCall[0]).toBe('/api/agents/uuid-1');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.deleted).toBe('daily-standup');
  });
});

