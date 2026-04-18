/**
 * llm Organ Tool (Orchestrator Wrapper)
 *
 * Thin adapter around runLlmCall from execution/llm-organ. The shared
 * helper owns the validation, routing, and call logic so both the
 * orchestrator-chat tool surface and the agent-execution tool executor
 * (execution/tool-dispatch/llm-executor) stay in lockstep.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { runLlmCall } from '../../execution/llm-organ.js';

export const LLM_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'llm',
    description:
      'Invoke an LLM for a specific sub-task. Agents act as sub-orchestrators: call this tool with a `purpose` that matches what the brain step is doing (reasoning, generation, summarization, extraction, critique, translation, classification, planning, etc.). The router picks the right model based on the agent\'s model_policy, workspace defaults, and call-site constraints. Use this instead of assuming any specific model. Returns { text, model_used, provider, tokens, cost_cents, latency_ms }.',
    input_schema: {
      type: 'object' as const,
      properties: {
        purpose: {
          type: 'string',
          enum: [
            'orchestrator_chat', 'agent_task', 'planning', 'browser_automation',
            'memory_extraction', 'ocr', 'workflow_step', 'simple_classification',
            'desktop_control', 'reasoning', 'generation', 'summarization',
            'extraction', 'critique', 'translation', 'embedding',
          ],
          description: 'The semantic purpose of this call. Drives model selection. Default: reasoning.',
        },
        prompt: {
          oneOf: [
            { type: 'string', description: 'A plain user prompt.' },
            {
              type: 'object',
              properties: {
                system: { type: 'string', description: 'Optional system prompt.' },
                messages: {
                  type: 'array',
                  description: 'Chat-style messages with role + content.',
                  items: {
                    type: 'object',
                    properties: {
                      role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
                      content: { type: 'string' },
                    },
                    required: ['role', 'content'],
                  },
                },
              },
            },
          ],
          description: 'Either a plain string or { system?, messages[] }.',
        },
        system: { type: 'string', description: 'Optional system prompt when `prompt` is a plain string.' },
        max_tokens: { type: 'number', description: 'Maximum output tokens.' },
        temperature: { type: 'number', description: 'Sampling temperature (provider default when omitted).' },
        local_only: { type: 'boolean', description: 'Force local inference; do not use cloud providers.' },
        prefer_model: { type: 'string', description: 'Call-site model override. Tightest win over agent and workspace defaults.' },
        max_cost_cents: { type: 'number', description: 'Advisory cost ceiling in cents. Warnings surface in cap_warning if exceeded.' },
        difficulty: { type: 'string', enum: ['simple', 'moderate', 'complex'], description: 'Hint for difficulty-aware routing.' },
      },
      required: ['prompt'],
    },
  },
];

export async function llmTool(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx.modelRouter) {
    return {
      success: false,
      error: 'llm tool: ModelRouter is not available in this context. Start the daemon with a model provider configured.',
    };
  }

  // Gap 13 follow-up 1b: this tool is only registered in the orchestrator
  // tool registry, which runs inside the interactive chat loop (see
  // orchestrator/tools/registry.ts). Every invocation is operator-initiated
  // in the current request cycle, so tag origin='interactive' to exclude
  // the row from the autonomous daily cap sum. Agent-task invocations of
  // the same `llm` tool name go through execution/tool-dispatch/llm-
  // executor.ts, which stays on the 'autonomous' default.
  const result = await runLlmCall(
    {
      modelRouter: ctx.modelRouter,
      db: ctx.db,
      workspaceId: ctx.workspaceId,
      currentAgentId: ctx.currentAgentId,
      origin: 'interactive',
    },
    input,
  );

  if (result.ok) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
