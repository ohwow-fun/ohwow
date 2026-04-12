/**
 * LLM Organ — shared core for the `llm` tool.
 *
 * Both the orchestrator-side tool (src/orchestrator/tools/llm.ts) and the
 * execution-side tool executor (src/execution/tool-dispatch/llm-executor.ts)
 * call into this module so the per-sub-task routing logic lives in exactly
 * one place. Keeping it here avoids circular imports between orchestrator/
 * and execution/ (this file already depends only on execution internals).
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';
import type { AgentModelPolicy, Purpose } from './execution-policy.js';
import type {
  CreateMessageParams,
  ModelMessage,
  ModelRouter,
} from './model-router.js';

export const VALID_PURPOSES: readonly Purpose[] = [
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

export interface LlmCallDeps {
  modelRouter: ModelRouter;
  db: DatabaseAdapter;
  /** Workspace this call is attributed to. Used for telemetry rows. */
  workspaceId: string;
  /** The agent running the call, when invoked inside an agent task. */
  currentAgentId?: string;
  /** The task this call belongs to, when known. Recorded in telemetry. */
  currentTaskId?: string;
}

/**
 * Persist a row in the llm_calls telemetry table. Best-effort: a
 * telemetry failure must never cause the underlying llm call to fail, so
 * errors are swallowed and logged at warn level.
 */
async function recordLlmCallTelemetry(
  deps: LlmCallDeps,
  row: {
    purpose: Purpose;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    latencyMs: number;
    success: boolean;
    errorMessage?: string;
  },
): Promise<void> {
  try {
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `llm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await deps.db.from('llm_calls').insert({
      id,
      workspace_id: deps.workspaceId,
      agent_id: deps.currentAgentId ?? null,
      task_id: deps.currentTaskId ?? null,
      purpose: row.purpose,
      provider: row.provider,
      model: row.model,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      cost_cents: row.costCents,
      latency_ms: row.latencyMs,
      success: row.success ? 1 : 0,
      error_message: row.errorMessage ?? null,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err }, 'llm organ: failed to record telemetry row');
  }
}

export interface LlmCallInput {
  purpose?: unknown;
  prompt?: unknown;
  system?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  local_only?: unknown;
  prefer_model?: unknown;
  max_cost_cents?: unknown;
  difficulty?: unknown;
}

export interface LlmCallOk {
  text: string;
  model_used: string;
  provider: string;
  purpose: Purpose;
  policy: { modelSource: string; fallback: string; creditBudget?: number };
  tokens: { input: number; output: number };
  cost_cents: number;
  latency_ms: number;
  cap_warning?: string;
}

export type LlmCallResult =
  | { ok: true; data: LlmCallOk }
  | { ok: false; error: string };

function isValidPurpose(value: unknown): value is Purpose {
  return typeof value === 'string' && (VALID_PURPOSES as readonly string[]).includes(value);
}

function asMessageRole(role: unknown): ModelMessage['role'] {
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') {
    return role;
  }
  return 'user';
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asDifficulty(value: unknown): 'simple' | 'moderate' | 'complex' | undefined {
  return value === 'simple' || value === 'moderate' || value === 'complex' ? value : undefined;
}

async function loadAgentPolicy(
  db: DatabaseAdapter,
  agentId: string,
): Promise<AgentModelPolicy | undefined> {
  try {
    const { data } = await db
      .from<{ config: string | Record<string, unknown> }>('agent_workforce_agents')
      .select('config')
      .eq('id', agentId)
      .maybeSingle();
    if (!data?.config) return undefined;
    const parsed =
      typeof data.config === 'string' ? JSON.parse(data.config) : data.config;
    return (parsed as { model_policy?: AgentModelPolicy }).model_policy;
  } catch (err) {
    logger.warn(
      { err, agentId },
      'llm organ: failed to load agent model policy, falling back to workspace defaults',
    );
    return undefined;
  }
}

/**
 * Normalize a free-form `prompt` input into a ModelMessage array and an
 * optional system prompt. Accepts either a plain string or an object of the
 * shape { system?, messages: [{role, content}] }.
 */
function normalizePrompt(
  input: LlmCallInput,
): { ok: true; system?: string; messages: ModelMessage[] } | { ok: false; error: string } {
  const systemFallback = asString(input.system);

  if (typeof input.prompt === 'string') {
    if (!input.prompt.trim()) {
      return { ok: false, error: 'llm organ: `prompt` string is empty.' };
    }
    return {
      ok: true,
      system: systemFallback,
      messages: [{ role: 'user', content: input.prompt }],
    };
  }

  if (input.prompt && typeof input.prompt === 'object') {
    const obj = input.prompt as { system?: unknown; messages?: unknown };
    const system = asString(obj.system) ?? systemFallback;
    const rawMessages = Array.isArray(obj.messages) ? obj.messages : [];
    if (rawMessages.length === 0) {
      return { ok: false, error: 'llm organ: `prompt.messages` must contain at least one message.' };
    }
    const messages: ModelMessage[] = rawMessages.map((m) => {
      const mObj = m as { role?: unknown; content?: unknown };
      return {
        role: asMessageRole(mObj.role),
        content: typeof mObj.content === 'string' ? mObj.content : JSON.stringify(mObj.content ?? ''),
      };
    });
    return { ok: true, system, messages };
  }

  return {
    ok: false,
    error: 'llm organ: `prompt` is required — either a string or an object with { system?, messages[] }.',
  };
}

/**
 * Shared implementation for the `llm` organ. Validates input, loads the
 * calling agent's model policy, asks ModelRouter to pick a provider +
 * model for the Purpose, executes the call, and returns the result with
 * telemetry fields populated.
 */
export async function runLlmCall(
  deps: LlmCallDeps,
  input: LlmCallInput,
): Promise<LlmCallResult> {
  if (!deps.modelRouter) {
    return { ok: false, error: 'llm organ: ModelRouter is not available in this context.' };
  }

  const purposeValue = input.purpose ?? 'reasoning';
  if (!isValidPurpose(purposeValue)) {
    return {
      ok: false,
      error: `llm organ: invalid purpose "${String(purposeValue)}". Valid: ${VALID_PURPOSES.join(', ')}.`,
    };
  }
  const purpose: Purpose = purposeValue;

  const normalized = normalizePrompt(input);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }

  let agentPolicy: AgentModelPolicy | undefined;
  if (deps.currentAgentId) {
    agentPolicy = await loadAgentPolicy(deps.db, deps.currentAgentId);
  }

  let selection;
  try {
    selection = await deps.modelRouter.selectForPurpose({
      purpose,
      agent: agentPolicy,
      constraints: {
        preferModel: asString(input.prefer_model),
        localOnly: asBool(input.local_only),
        maxCostCents: asNumber(input.max_cost_cents),
        difficulty: asDifficulty(input.difficulty),
      },
    });
  } catch (err) {
    const errorMessage = `llm organ: no provider available for purpose "${purpose}": ${err instanceof Error ? err.message : 'unknown error'}`;
    // Record the routing failure so operators can see "no provider" patterns.
    await recordLlmCallTelemetry(deps, {
      purpose,
      provider: 'none',
      model: 'none',
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      latencyMs: 0,
      success: false,
      errorMessage,
    });
    return { ok: false, error: errorMessage };
  }

  const startMs = Date.now();
  try {
    const params: CreateMessageParams = {
      system: normalized.system,
      messages: normalized.messages,
      maxTokens: asNumber(input.max_tokens),
      temperature: asNumber(input.temperature),
    };
    if (selection.model) {
      params.model = selection.model;
    }
    const response = await selection.provider.createMessage(params);
    const latencyMs = Date.now() - startMs;

    const capWarning =
      selection.maxCostCents !== undefined &&
      response.costCents !== undefined &&
      response.costCents > selection.maxCostCents
        ? `cost ${response.costCents}¢ exceeded cap ${selection.maxCostCents}¢`
        : undefined;

    // Fire-and-forget telemetry — the result is returned to the caller
    // regardless of whether the row lands.
    await recordLlmCallTelemetry(deps, {
      purpose,
      provider: response.provider,
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costCents: response.costCents ?? 0,
      latencyMs,
      success: true,
    });

    return {
      ok: true,
      data: {
        text: response.content,
        model_used: response.model,
        provider: response.provider,
        purpose,
        policy: {
          modelSource: selection.policy.modelSource,
          fallback: selection.policy.fallback,
          creditBudget: selection.policy.creditBudget,
        },
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
    const errorMessage = `llm organ: call failed after ${latencyMs}ms via ${selection.provider.name}: ${err instanceof Error ? err.message : 'unknown error'}`;
    logger.error(
      { err, purpose, provider: selection.provider.name, model: selection.model, latencyMs },
      'llm organ: provider call failed',
    );
    await recordLlmCallTelemetry(deps, {
      purpose,
      provider: selection.provider.name,
      model: selection.model ?? 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      latencyMs,
      success: false,
      errorMessage,
    });
    return { ok: false, error: errorMessage };
  }
}
