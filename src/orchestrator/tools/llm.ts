/**
 * llm Organ Tool — per-sub-task LLM invocation for agent sub-orchestration.
 *
 * Agents are not pinned to a single model. They act as mini-orchestrators
 * that pick a brain per sub-task by calling this tool with a `purpose` tag.
 * The ModelRouter honors the agent's model_policy, workspace defaults, and
 * call-site constraints, then dispatches to the right provider (Ollama,
 * Anthropic, OpenRouter, Claude Code, MLX, llama.cpp, OpenAI-compatible).
 *
 * Return shape includes the concrete model used, provider name, token
 * counts, cost (when reported), and latency so callers and the telemetry
 * layer can feed adaptive routing.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import type { AgentModelPolicy, Purpose } from '../../execution/execution-policy.js';
import type { CreateMessageParams, ModelMessage } from '../../execution/model-router.js';
import { logger } from '../../lib/logger.js';

const VALID_PURPOSES: readonly Purpose[] = [
  'orchestrator_chat',
  'agent_task',
  'planning',
  'browser_automation',
  'memory_extraction',
  'ocr',
  'workflow_step',
  'simple_classification',
  'desktop_control',
  'reasoning',
  'generation',
  'summarization',
  'extraction',
  'critique',
  'translation',
  'embedding',
] as const;

interface LlmPromptObject {
  system?: string;
  messages?: Array<{ role: string; content: string }>;
}

interface LlmInput {
  purpose?: string;
  prompt?: string | LlmPromptObject;
  system?: string;
  max_tokens?: number;
  temperature?: number;
  local_only?: boolean;
  prefer_model?: string;
  max_cost_cents?: number;
  difficulty?: 'simple' | 'moderate' | 'complex';
}

function isValidPurpose(value: unknown): value is Purpose {
  return typeof value === 'string' && (VALID_PURPOSES as readonly string[]).includes(value);
}

function asMessageRole(role: string): ModelMessage['role'] {
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') {
    return role;
  }
  return 'user';
}

async function loadAgentPolicy(
  ctx: LocalToolContext,
  agentId: string,
): Promise<AgentModelPolicy | undefined> {
  try {
    const { data } = await ctx.db
      .from<{ config: string | Record<string, unknown> }>('agent_workforce_agents')
      .select('config')
      .eq('id', agentId)
      .maybeSingle();
    if (!data?.config) return undefined;
    const parsed =
      typeof data.config === 'string' ? JSON.parse(data.config) : data.config;
    const policy = (parsed as { model_policy?: AgentModelPolicy }).model_policy;
    return policy;
  } catch (err) {
    logger.warn(
      { err, agentId },
      'llm tool: failed to load agent model policy, falling back to workspace defaults',
    );
    return undefined;
  }
}

export async function llmTool(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx.modelRouter) {
    return {
      success: false,
      error: 'ModelRouter is not available in this context. Start the daemon with a model provider configured.',
    };
  }

  const typed = input as LlmInput;

  // Validate purpose. Default to "reasoning" which is the closest match to the
  // common case: "call a brain to think about something".
  const purposeValue: unknown = typed.purpose ?? 'reasoning';
  if (!isValidPurpose(purposeValue)) {
    return {
      success: false,
      error: `Invalid purpose "${String(purposeValue)}". Valid purposes: ${VALID_PURPOSES.join(', ')}.`,
    };
  }
  const purpose: Purpose = purposeValue;

  // Normalize prompt shape → messages array.
  let messages: ModelMessage[];
  let system: string | undefined;
  if (typeof typed.prompt === 'string') {
    system = typed.system;
    messages = [{ role: 'user', content: typed.prompt }];
  } else if (typed.prompt && typeof typed.prompt === 'object') {
    system = typed.prompt.system ?? typed.system;
    const rawMessages = Array.isArray(typed.prompt.messages) ? typed.prompt.messages : [];
    messages = rawMessages.map((m) => ({
      role: asMessageRole(m.role),
      content: m.content,
    }));
  } else {
    return {
      success: false,
      error: 'llm tool requires a `prompt` argument: either a string or an object with { system?, messages[] }.',
    };
  }

  if (messages.length === 0) {
    return {
      success: false,
      error: 'llm tool requires at least one message in `prompt.messages` (or a non-empty string prompt).',
    };
  }

  // Load per-agent model policy when running inside an agent task.
  let agentPolicy: AgentModelPolicy | undefined;
  if (ctx.currentAgentId) {
    agentPolicy = await loadAgentPolicy(ctx, ctx.currentAgentId);
  }

  // Ask the router to select a provider and model for this purpose.
  let selection;
  try {
    selection = await ctx.modelRouter.selectForPurpose({
      purpose,
      agent: agentPolicy,
      constraints: {
        preferModel: typed.prefer_model,
        localOnly: typed.local_only,
        maxCostCents: typed.max_cost_cents,
        difficulty: typed.difficulty,
      },
    });
  } catch (err) {
    return {
      success: false,
      error: `llm tool: no provider available for purpose "${purpose}": ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }

  // Execute the call and measure latency. Token and cost data come from the
  // provider response so the caller can feed telemetry and adaptive routing.
  const startMs = Date.now();
  try {
    const params: CreateMessageParams = {
      system,
      messages,
      maxTokens: typed.max_tokens,
      temperature: typed.temperature,
    };
    if (selection.model) {
      params.model = selection.model;
    }
    const response = await selection.provider.createMessage(params);
    const latencyMs = Date.now() - startMs;

    // Hard cost-cap enforcement: if the provider reports a cost and it
    // exceeded the agent/call-site cap, return the result but surface a
    // warning. The cap is advisory here because the model has already run;
    // real enforcement belongs in the router's pre-flight budget check,
    // which is a follow-up.
    const capWarning =
      selection.maxCostCents !== undefined &&
      response.costCents !== undefined &&
      response.costCents > selection.maxCostCents
        ? `cost ${response.costCents}¢ exceeded cap ${selection.maxCostCents}¢`
        : undefined;

    return {
      success: true,
      data: {
        text: response.content,
        model_used: response.model,
        provider: response.provider,
        purpose,
        policy: selection.policy,
        tokens: {
          input: response.inputTokens,
          output: response.outputTokens,
        },
        cost_cents: response.costCents ?? 0,
        latency_ms: latencyMs,
        cap_warning: capWarning,
      },
    };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    logger.error(
      { err, purpose, provider: selection.provider.name, model: selection.model, latencyMs },
      'llm tool call failed',
    );
    return {
      success: false,
      error: `llm call failed after ${latencyMs}ms via ${selection.provider.name}: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}
