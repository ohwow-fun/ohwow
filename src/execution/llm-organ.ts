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
  ModelResponseWithTools,
  ModelRouter,
  OpenAITool,
  RoutingHistory,
} from './model-router.js';
import {
  isSelectableModel,
  resolveRouterDefault,
  type TaskClass,
} from './router-defaults.js';
import {
  applyBudgetMiddleware,
  type BudgetMiddlewareDeps,
} from './budget-middleware.js';
import type { CallOrigin } from './budget-meter.js';

const VALID_TASK_CLASSES: readonly TaskClass[] = [
  'agentic_coding',
  'computer_use',
  'hardest_reasoning',
  'agentic_search',
  'bulk_cost_sensitive',
  'private_offline',
] as const;

function asTaskClass(value: unknown): TaskClass | undefined {
  return typeof value === 'string' && (VALID_TASK_CLASSES as readonly string[]).includes(value)
    ? (value as TaskClass)
    : undefined;
}

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
  /**
   * Self-bench experiment id when the call originates from a probe or
   * intervene step (patch-author, roadmap-updater, experiment-author,
   * proposal-generator, ...). Recorded in llm_calls.experiment_id so the
   * cost-observer can rank top spenders per experiment and flag those
   * spending without producing non-trivial findings.
   *
   * Optional and back-compat: callers that don't pass it write NULL and
   * show up as "(unattributed)" in rollups.
   */
  experimentId?: string;
  /**
   * Gap 13 origin tag. Callers that are servicing an operator-initiated
   * request (chat UI, manual tool invocation from TUI/web, /api/llm)
   * pass 'interactive' so the row is excluded from the autonomous daily
   * cap sum. Callers inside schedulers, triggers, or self-bench leave
   * this unset and persist 'autonomous' (the cost-safe default).
   *
   * This top-level field is the tag-only path: it mirrors the `origin`
   * field already exposed on `recordLlmCallTelemetry`'s deps param
   * (used by the chat-loop's direct telemetry write) so call sites
   * that want to mark a call interactive without wiring the full
   * budget middleware can do so with a single field.
   *
   * `deps.budget.origin` still works for call sites that ARE wiring the
   * meter; when both are set, budget.origin wins because the meter is
   * the richer path.
   */
  origin?: CallOrigin;
  /**
   * Gap 13 budget-enforcement wiring. When set, runLlmCall consults the
   * middleware before dispatch: the middleware may demote the task
   * class's default to a cheaper model in the 85-95% band or throw
   * BudgetPausedError / BudgetExceededError in the 95-100% / >=100%
   * bands. When unset (back-compat default), the middleware is skipped
   * and calls dispatch exactly as they did pre-gap-13. This keeps the
   * meter opt-in per call site while the daemon wires it up cleanly.
   */
  budget?: BudgetMiddlewareDeps & {
    /** Per-workspace daily cap in USD. Undefined => DEFAULT_AUTONOMOUS_SPEND_LIMIT_USD. */
    limitUsd?: number;
    /** autonomous | interactive. Defaults to autonomous when the call is inside an agent/task context. */
    origin?: CallOrigin;
    /** Revenue-critical bypass for the 95-100% band. */
    bypass?: 'revenue_critical';
  };
}

/**
 * Build a RoutingHistory from recent llm_calls rows for this workspace,
 * agent, and purpose. Feeds adaptive routing in ModelRouter.getProvider:
 * the router escalates to a more capable model when recent quality is
 * low, and allows downgrade when quality has been consistently high.
 *
 * Signal used: success rate of the last N llm_calls rows, scaled to
 * 0-100 as a proxy for the router's `avgTruthScore` field. This is a
 * pragmatic approximation — a provider that always returns garbage
 * would still have a 100% success rate — but it correctly catches the
 * "provider keeps failing, escalate" pattern which is the main thing
 * the current router adaptive path uses routingHistory for.
 *
 * When proper response scoring lands, swap `success_rate * 100` for
 * the real score without touching callers.
 */
async function computeRoutingHistory(
  db: DatabaseAdapter,
  workspaceId: string,
  agentId: string | undefined,
  purpose: Purpose,
): Promise<RoutingHistory | undefined> {
  try {
    // Read the most recent 20 rows for this (workspace, agent, purpose)
    // tuple. 20 is enough to see a pattern without dragging in ancient data.
    let query = db
      .from<{ success: number }>('llm_calls')
      .select('success')
      .eq('workspace_id', workspaceId)
      .eq('purpose', purpose);
    if (agentId) {
      query = query.eq('agent_id', agentId);
    }
    const { data } = await query
      .order('created_at', { ascending: false })
      .limit(20);
    const rows = (data ?? []) as Array<{ success: number }>;
    if (rows.length < 3) return undefined; // not enough signal yet
    const successes = rows.reduce((sum, r) => sum + (r.success ? 1 : 0), 0);
    const avgTruthScore = Math.round((successes / rows.length) * 100);
    return { avgTruthScore, attempts: rows.length };
  } catch (err) {
    logger.warn({ err, workspaceId, agentId, purpose }, 'llm organ: failed to compute routingHistory');
    return undefined;
  }
}

/**
 * Persist a row in the llm_calls telemetry table. Best-effort: a
 * telemetry failure must never cause the underlying llm call to fail, so
 * errors are swallowed and logged at warn level.
 *
 * Exported so direct provider callers (e.g. the orchestrator chat loop,
 * which bypasses llm-organ's dispatch) can write llm_calls rows too.
 * Accepts the narrower subset of LlmCallDeps it actually uses.
 */
export async function recordLlmCallTelemetry(
  deps: {
    db: DatabaseAdapter;
    workspaceId: string;
    currentAgentId?: string;
    currentTaskId?: string;
    experimentId?: string;
    /**
     * Gap 13 origin tag. 'autonomous' (default) is summed by the budget
     * meter against the per-workspace daily cap; 'interactive' rows
     * (operator-initiated chat, manual tool invocations) are excluded.
     * Callers that don't pass it persist 'autonomous', which matches
     * pre-migration-141 meter behavior exactly.
     */
    origin?: CallOrigin;
  },
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
    /**
     * Number of tool_calls in the model response for this single LLM call.
     * 0 is a real value (model was offered tools and chose none). Leave
     * undefined when the call wasn't offered tools at all, so the column
     * stays NULL and doesn't pollute "tool-call rate" aggregations.
     */
    toolCallCount?: number;
    /**
     * 'work' when the call site's task input looksLikeToolWork, 'chat' when
     * it doesn't, undefined when the call site has no task input
     * (generation, orchestrator chat, ad-hoc /api/llm).
     */
    taskShape?: 'work' | 'chat';
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
      experiment_id: deps.experimentId ?? null,
      origin: deps.origin ?? 'autonomous',
      purpose: row.purpose,
      provider: row.provider,
      model: row.model,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      cost_cents: row.costCents,
      latency_ms: row.latencyMs,
      success: row.success ? 1 : 0,
      error_message: row.errorMessage ?? null,
      tool_call_count: row.toolCallCount ?? null,
      task_shape: row.taskShape ?? null,
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
  /**
   * Multi-turn conversation history. Top-level alternative to passing an
   * object `prompt` with `{ system?, messages[] }`. When both `prompt`
   * and `messages` are supplied, `messages` wins. Each entry carries
   * { role, content, tool_calls?, tool_call_id? } so callers can feed
   * tool_use / tool_result blocks back into the next turn.
   */
  messages?: unknown;
  /**
   * OpenAI-format tool definitions. When non-empty, the organ dispatches
   * to provider.createMessageWithTools and the response includes a
   * `content` array with text and tool_use blocks. The caller is
   * responsible for executing tools and looping by feeding tool_result
   * blocks back via `messages` on the next call.
   */
  tools?: unknown;
  /** OpenAI-format tool_choice ('auto' | 'required' | 'none'). Optional. */
  tool_choice?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  local_only?: unknown;
  prefer_model?: unknown;
  max_cost_cents?: unknown;
  difficulty?: unknown;
  /**
   * Optional TaskClass hint. When set and `prefer_model` is unset, the
   * organ resolves the class's default via `resolveRouterDefault` and
   * passes that model string down as `preferModel`. Opt-in Opus 4.7 is
   * surfaced by passing the opt-in model string explicitly via
   * `prefer_model`; the organ validates it against `isOptInModel` for
   * the task class before honoring it.
   */
  task_class?: unknown;
}

/**
 * Normalized content block returned by ohwow_llm. Mirrors the shape used
 * by Anthropic's content blocks so callers can feed tool_use blocks back
 * into the next turn as tool_result blocks via the `messages` history.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export interface LlmCallOk {
  /** Joined text content. Convenience field for the no-tools case. */
  text: string;
  /**
   * Structured content blocks. Always present. For text-only responses
   * this is a single { type: 'text' } entry. When the model called
   * tools, includes one { type: 'tool_use' } entry per tool call.
   */
  content: ContentBlock[];
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
 * Normalize a free-form `prompt` / `messages` input into a ModelMessage
 * array and an optional system prompt.
 *
 * Accepted shapes:
 *  - top-level `messages: [{role, content, tool_calls?, tool_call_id?}]`
 *    (preferred for multi-turn / tool-use loops)
 *  - top-level `prompt: string` plus optional top-level `system`
 *  - top-level `prompt: { system?, messages[] }` (legacy compound form)
 *
 * When both are supplied, `messages` wins because it's the structured
 * form callers reach for when they're feeding tool_result blocks back
 * into the next iteration of a tool-use loop.
 */
function normalizeMessageEntry(m: unknown): ModelMessage {
  const mObj = (m ?? {}) as {
    role?: unknown;
    content?: unknown;
    tool_calls?: unknown;
    tool_call_id?: unknown;
  };
  const message: ModelMessage = {
    role: asMessageRole(mObj.role),
    content: typeof mObj.content === 'string'
      ? mObj.content
      : (Array.isArray(mObj.content)
        // Tool-result / multipart blocks pass through as-is so providers
        // that understand them (Anthropic) can dispatch them; the OpenAI
        // adapters serialize them via tool_calls + tool_call_id below.
        ? (mObj.content as ModelMessage['content'])
        : JSON.stringify(mObj.content ?? '')),
  };
  if (Array.isArray(mObj.tool_calls)) {
    message.tool_calls = mObj.tool_calls as ModelMessage['tool_calls'];
  }
  if (typeof mObj.tool_call_id === 'string') {
    message.tool_call_id = mObj.tool_call_id;
  }
  return message;
}

function normalizePrompt(
  input: LlmCallInput,
): { ok: true; system?: string; messages: ModelMessage[] } | { ok: false; error: string } {
  const systemFallback = asString(input.system);

  // Top-level messages array wins. This is the path tool-use callers use
  // when looping (each iteration appends an assistant message with
  // tool_calls, then a user/tool message with tool_results).
  if (Array.isArray(input.messages)) {
    if (input.messages.length === 0) {
      return { ok: false, error: 'llm organ: `messages` must contain at least one message.' };
    }
    return {
      ok: true,
      system: systemFallback,
      messages: input.messages.map(normalizeMessageEntry),
    };
  }

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
    return { ok: true, system, messages: rawMessages.map(normalizeMessageEntry) };
  }

  return {
    ok: false,
    error: 'llm organ: `prompt` or `messages` is required.',
  };
}

/**
 * Validate and normalize the optional `tools` array. Returns ok:false
 * when the shape is invalid so the call fails fast with a clear error
 * instead of dispatching to a provider that would 400 on malformed
 * tool definitions.
 */
function normalizeTools(
  raw: unknown,
): { ok: true; tools: OpenAITool[] | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, tools: undefined };
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'llm organ: `tools` must be an array of tool definitions.' };
  }
  if (raw.length === 0) return { ok: true, tools: undefined };
  const tools: OpenAITool[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') {
      return { ok: false, error: 'llm organ: each tool must be an object.' };
    }
    const tObj = t as Record<string, unknown>;
    // Accept either Anthropic shape ({name, description, input_schema}) or
    // OpenAI shape ({type:"function", function:{name, description, parameters}}).
    if (tObj.type === 'function' && tObj.function && typeof tObj.function === 'object') {
      const fn = tObj.function as Record<string, unknown>;
      if (typeof fn.name !== 'string') {
        return { ok: false, error: 'llm organ: tool.function.name is required.' };
      }
      tools.push({
        type: 'function',
        function: {
          name: fn.name,
          description: typeof fn.description === 'string' ? fn.description : '',
          parameters: (fn.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
        },
      });
      continue;
    }
    if (typeof tObj.name === 'string') {
      tools.push({
        type: 'function',
        function: {
          name: tObj.name,
          description: typeof tObj.description === 'string' ? tObj.description : '',
          parameters: (tObj.input_schema as Record<string, unknown>)
            ?? (tObj.parameters as Record<string, unknown>)
            ?? { type: 'object', properties: {} },
        },
      });
      continue;
    }
    return { ok: false, error: 'llm organ: tool entry missing name (expected {name, description, input_schema} or {type:"function", function:{...}}).' };
  }
  return { ok: true, tools };
}

/**
 * Convert a provider response (with or without toolCalls) into the
 * normalized ContentBlock[] shape that ohwow_llm returns to callers.
 * Anthropic-style block layout: text first, tool_use blocks after.
 */
function buildContentBlocks(response: { content: string }, toolCalls?: ModelResponseWithTools['toolCalls']): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (response.content && response.content.length > 0) {
    blocks.push({ type: 'text', text: response.content });
  }
  if (toolCalls) {
    for (const call of toolCalls) {
      let parsedInput: Record<string, unknown> = {};
      try {
        parsedInput = call.function.arguments
          ? JSON.parse(call.function.arguments) as Record<string, unknown>
          : {};
      } catch {
        // Provider returned a non-JSON arguments string. Surface it raw so
        // the caller can decide how to handle it instead of dropping the
        // entire tool call.
        parsedInput = { _raw_arguments: call.function.arguments };
      }
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: parsedInput,
      });
    }
  }
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' });
  }
  return blocks;
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

  // Telemetry deps carry the origin tag onto every llm_calls row this
  // invocation writes. Gap 13: `origin='autonomous'` is the default so
  // the cap keeps guarding the autonomous loop. Callers that wire
  // `deps.budget.origin = 'interactive'` (budget-meter path) or
  // `deps.origin = 'interactive'` (tag-only path) opt their row out of
  // the sum. Budget wins when both are set — it's the richer wiring.
  const telemetryDeps = {
    db: deps.db,
    workspaceId: deps.workspaceId,
    currentAgentId: deps.currentAgentId,
    currentTaskId: deps.currentTaskId,
    experimentId: deps.experimentId,
    origin: deps.budget?.origin ?? deps.origin ?? 'autonomous' as CallOrigin,
  };

  const normalized = normalizePrompt(input);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }

  const normalizedTools = normalizeTools(input.tools);
  if (!normalizedTools.ok) {
    return { ok: false, error: normalizedTools.error };
  }
  const tools = normalizedTools.tools;

  let agentPolicy: AgentModelPolicy | undefined;
  if (deps.currentAgentId) {
    agentPolicy = await loadAgentPolicy(deps.db, deps.currentAgentId);
  }

  // Compute recent success history for this (workspace, agent, purpose)
  // triple so the router can adaptively escalate on low quality or
  // downgrade on consistently-high quality. Best-effort — on failure or
  // insufficient data, returns undefined and the router uses its own
  // default routing.
  const routingHistory = await computeRoutingHistory(
    deps.db,
    deps.workspaceId,
    deps.currentAgentId,
    purpose,
  );

  // Task-class default resolution. When the caller tags a call with
  // `task_class` (eg "agentic_coding", "hardest_reasoning") and did not
  // supply an explicit `prefer_model`, the router-defaults table picks
  // the cheap-enough-for-the-loop default for that class. Callers that
  // want to opt into a registered alternative (eg claude-opus-4-7 on
  // hardest_reasoning) pass the model string via `prefer_model`. The
  // organ validates it against `isSelectableModel` for the task class
  // and logs a breadcrumb if it's unknown so the budget meter added in
  // gap 13 can surface the rate of off-allowlist overrides.
  const taskClass = asTaskClass(input.task_class);
  const explicitPreferModel = asString(input.prefer_model);
  let preferModel = explicitPreferModel;
  if (!preferModel && taskClass) {
    preferModel = resolveRouterDefault(taskClass).model;
  }

  // Gap 13: budget-meter consult. The middleware may demote preferModel
  // to a cheaper fallback or throw to halt the call entirely. Only
  // consulted when the caller wires `deps.budget` (daemon path does;
  // direct-provider unit tests skip it). Errors thrown here are
  // BudgetPausedError / BudgetExceededError and propagate to the
  // caller untouched so the operator surface sees them verbatim.
  if (deps.budget && !explicitPreferModel && taskClass) {
    const middlewareResult = await applyBudgetMiddleware(
      { meter: deps.budget.meter, emittedToday: deps.budget.emittedToday, emitPulse: deps.budget.emitPulse },
      {
        workspaceId: deps.workspaceId,
        limitUsd: deps.budget.limitUsd,
        origin: deps.budget.origin ?? deps.origin ?? 'autonomous',
        taskClass,
        bypass: deps.budget.bypass,
      },
    );
    if (middlewareResult.demoted) {
      preferModel = middlewareResult.routerDefault.model;
    }
  }
  if (explicitPreferModel && taskClass && !isSelectableModel(taskClass, explicitPreferModel)) {
    // Not an error — per-agent / workspace overrides are allowed to
    // reach beyond the allow-list. Just log it so the budget meter
    // added in gap 13 has the breadcrumb.
    logger.debug(
      { taskClass, preferModel: explicitPreferModel },
      'llm organ: prefer_model is not registered as an opt-in for this task_class',
    );
  }

  let selection;
  try {
    selection = await deps.modelRouter.selectForPurpose({
      purpose,
      agent: agentPolicy,
      constraints: {
        preferModel,
        localOnly: asBool(input.local_only),
        maxCostCents: asNumber(input.max_cost_cents),
        difficulty: asDifficulty(input.difficulty),
      },
      routingHistory,
    });
  } catch (err) {
    const errorMessage = `llm organ: no provider available for purpose "${purpose}": ${err instanceof Error ? err.message : 'unknown error'}`;
    // Record the routing failure so operators can see "no provider" patterns.
    await recordLlmCallTelemetry(telemetryDeps, {
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

    // Dispatch through createMessageWithTools when the caller supplied a
    // non-empty tools array AND the selected provider supports it. All
    // providers in the codebase implement it today, but the interface
    // marks it optional, so guard before calling. If a provider lacks
    // tool-use support, fail fast with a clear error rather than silently
    // dropping the tools array.
    let response: { content: string; inputTokens: number; outputTokens: number; model: string; provider: ModelResponseWithTools['provider']; costCents?: number };
    let toolCalls: ModelResponseWithTools['toolCalls'] | undefined;
    if (tools && tools.length > 0) {
      if (!selection.provider.createMessageWithTools) {
        const errorMessage = `llm organ: provider "${selection.provider.name}" does not support tool calls.`;
        await recordLlmCallTelemetry(telemetryDeps, {
          purpose,
          provider: selection.provider.name,
          model: selection.model ?? 'unknown',
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
          latencyMs: Date.now() - startMs,
          success: false,
          errorMessage,
        });
        return { ok: false, error: errorMessage };
      }
      const toolResponse = await selection.provider.createMessageWithTools({ ...params, tools });
      response = toolResponse;
      toolCalls = toolResponse.toolCalls;
    } else {
      response = await selection.provider.createMessage(params);
    }
    const latencyMs = Date.now() - startMs;

    const capWarning =
      selection.maxCostCents !== undefined &&
      response.costCents !== undefined &&
      response.costCents > selection.maxCostCents
        ? `cost ${response.costCents}¢ exceeded cap ${selection.maxCostCents}¢`
        : undefined;

    // Fire-and-forget telemetry — the result is returned to the caller
    // regardless of whether the row lands. toolCallCount is only emitted
    // when the caller offered tools, so llm_calls aggregations can tell
    // "model didn't call a tool" apart from "tools weren't offered".
    await recordLlmCallTelemetry(telemetryDeps, {
      purpose,
      provider: response.provider,
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costCents: response.costCents ?? 0,
      latencyMs,
      success: true,
      toolCallCount: tools && tools.length > 0 ? (toolCalls?.length ?? 0) : undefined,
    });

    return {
      ok: true,
      data: {
        text: response.content,
        content: buildContentBlocks(response, toolCalls),
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
    await recordLlmCallTelemetry(telemetryDeps, {
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
