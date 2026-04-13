/**
 * Core MCP Tools
 * The original 6 tools: chat, agents, tasks, workspace status.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonApiClient } from '../api-client.js';

export function registerCoreTools(server: McpServer, client: DaemonApiClient): void {
  // ohwow_chat — Primary tool: send message to orchestrator (async).
  // Returns conversationId immediately. Poll with ohwow_get_chat until
  // status flips out of 'running'. Long turns survive client disconnects
  // and become inspectable from the dashboard.
  server.tool(
    'ohwow_chat',
    '[Orchestrator] Send a message to the OHWOW orchestrator (88+ internal tools). Returns conversationId immediately and dispatches the turn in the background. Poll ohwow_get_chat until status !== "running" to read the final assistant message. Use this for: desktop control, automation creation, agent scheduling, approval management, agent state persistence, A2A protocol, PDF forms, media generation, and any multi-step request not covered by the direct tools. Do NOT use for simple listing or CRUD operations that have dedicated tools.',
    {
      message: z.string().describe('The message or instruction to send to the orchestrator'),
      sessionId: z.string().optional().describe('Optional conversation id to continue an existing session. Omit for a new conversation.'),
    },
    async ({ message, sessionId }) => {
      try {
        // ?async=1 routes to the new background-dispatch path: the daemon
        // creates a conversation row, returns conversationId immediately,
        // and runs the orchestrator turn off-thread. Caller polls
        // ohwow_get_chat until status flips out of 'running'.
        const result = await client.post('/api/chat?async=1', { message, sessionId });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // ohwow_get_chat — Poll a conversation by id until the orchestrator turn
  // finishes. Returns { status, messages, last_error, ... }. Status values:
  // 'running' (still in flight), 'done' (ready), 'error' (look at last_error).
  server.tool(
    'ohwow_get_chat',
    '[Orchestrator] Poll an in-flight or completed orchestrator conversation by id. Returns { status, messages, last_error, ... }. Status: "running" = still in flight, keep polling. "done" = final assistant message is in messages[]. "error" = look at last_error. Use after ohwow_chat to wait for the turn to complete.',
    {
      conversationId: z.string().describe('The conversation id returned by ohwow_chat'),
    },
    async ({ conversationId }) => {
      try {
        const result = await client.get(`/api/chat/${conversationId}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );

  // ohwow_list_agents — List all agents
  server.tool(
    'ohwow_list_agents',
    '[Agents] List all agents in the OHWOW workspace with their status, role, and capabilities.',
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

  // ohwow_run_agent — Execute a specific agent
  server.tool(
    'ohwow_run_agent',
    '[Agents] Execute a specific agent with a prompt. Returns a task ID immediately (execution is async). Use ohwow_get_task to poll for status and result. Use ohwow_list_agents to find agent IDs.',
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

  // ohwow_get_task — Get task status and result
  server.tool(
    'ohwow_get_task',
    '[Tasks] Get the status and result of a task by its ID.',
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

  // ohwow_list_tasks — List recent tasks
  server.tool(
    'ohwow_list_tasks',
    '[Tasks] List recent tasks. Optionally filter by status or agent.',
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

  // ohwow_workspace_status — Workspace overview
  server.tool(
    'ohwow_workspace_status',
    '[Workspace] Get workspace status: agent count, uptime, tier, and system stats.',
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

  // ohwow_llm — Per-sub-task model routing organ.
  //
  // Exposes ohwow's ModelRouter.selectForPurpose to Claude Code. The caller
  // passes a semantic `purpose` and optional per-agent/call-site constraints;
  // ohwow picks the provider and model, runs the call, and returns the
  // result with telemetry (model_used, provider, tokens, cost_cents,
  // latency_ms). This is how Claude Code uses ohwow AS a router instead of
  // picking models itself.
  server.tool(
    'ohwow_llm',
    '[LLM Organ] Invoke ohwow\'s model router for a specific sub-task. Pass a `purpose` (reasoning, generation, summarization, extraction, critique, translation, planning, classification, etc.) and a `prompt` string. ohwow resolves the agent\'s model_policy (if agentId is given), workspace defaults, and constraints, then picks a provider+model and runs the call. Returns { text, model_used, provider, purpose, tokens, cost_cents, latency_ms }. Use this when you want ohwow to act as your model selector instead of pinning to a specific model yourself.',
    {
      purpose: z.enum([
        'orchestrator_chat', 'agent_task', 'planning', 'browser_automation',
        'memory_extraction', 'ocr', 'workflow_step', 'simple_classification',
        'desktop_control', 'reasoning', 'generation', 'summarization',
        'extraction', 'critique', 'translation', 'embedding',
      ]).optional().describe('Semantic purpose that drives routing. Defaults to "reasoning".'),
      prompt: z.string().describe('The user prompt to send to the selected model.'),
      system: z.string().optional().describe('Optional system prompt.'),
      agentId: z.string().optional().describe('Agent ID to load model_policy from. Omit to use workspace defaults only.'),
      max_tokens: z.number().optional().describe('Maximum output tokens.'),
      temperature: z.number().optional().describe('Sampling temperature.'),
      local_only: z.boolean().optional().describe('Force local inference (clamps modelSource to local).'),
      prefer_model: z.string().optional().describe('Call-site model override; wins over agent policy.'),
      max_cost_cents: z.number().optional().describe('Advisory cost ceiling in cents.'),
      difficulty: z.enum(['simple', 'moderate', 'complex']).optional().describe('Difficulty hint for escalation.'),
    },
    async (args) => {
      try {
        const result = await client.post('/api/llm', args as Record<string, unknown>);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }], isError: true };
      }
    },
  );
}
