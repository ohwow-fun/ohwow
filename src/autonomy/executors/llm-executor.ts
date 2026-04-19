/**
 * Real-LLM executor for autonomy plan rounds (Phase 6.9).
 *
 * Wraps the project's existing ModelRouter so the autonomy stack can run
 * a real Haiku-class model on the PLAN round only, while impl + qa
 * continue to run against the deterministic stub. Strictly opt-in via
 * the eval harness; never wired into production today (see TODO in
 * `src/autonomy/conductor.ts`).
 *
 * Scope constraints (Phase 6.9):
 *   - PLAN ONLY. Other kinds delegate to `opts.fallback`.
 *   - NO TOOLS. The plan round is pure system+user -> JSON. This bounds
 *     the blast radius and keeps parse expectations crisp.
 *   - HARD CAPS. Per-round wall clock + max output tokens; per-phase
 *     spend cap is enforced by the harness reading `meter.cents`.
 *
 * The executor builds a structured system prompt that includes the
 * mode-lens preamble (so revenue plans actually feel like revenue
 * plans), the RoundReturn TypeScript interface verbatim, and an
 * explicit "JSON-only-in-a-fence" instruction. On a parse failure the
 * executor re-prompts ONCE with a sharper instruction; second failure
 * throws `LlmExecutorError` so `round-runner.runRound` can convert it
 * into a `regressed` outcome with the parse error attached.
 */

import { logger } from '../../lib/logger.js';
import {
  type CreateMessageParams,
  type ModelMessage,
  type ModelProvider,
  type ModelResponse,
  type ModelRouter,
} from '../../execution/model-router.js';
import { getLens } from '../lenses/index.js';
import type {
  RoundBrief,
  RoundExecutor,
  RoundReturn,
  RoundStatus,
} from '../types.js';
import { MCP_VERBS_MARKER, MODE_LENS_MARKER, PLAN_SYSTEM_PROMPT_TEMPLATE } from './prompts/plan.js';

// ---------------------------------------------------------------------------
// Pricing — Anthropic Haiku 4.5 published pricing per million tokens.
// https://www.anthropic.com/pricing  (verified 2025-11; refresh on model bump)
// ---------------------------------------------------------------------------

const HAIKU_INPUT_USD_PER_M = 1.0;
const HAIKU_OUTPUT_USD_PER_M = 5.0;

/** Convert raw token counts into estimated spend, in fractional cents. */
export function estimateCostCents(
  inputTokens: number,
  outputTokens: number,
): number {
  const usd =
    (inputTokens / 1_000_000) * HAIKU_INPUT_USD_PER_M +
    (outputTokens / 1_000_000) * HAIKU_OUTPUT_USD_PER_M;
  // Round to 4 decimal places of a cent so accumulating many small calls
  // doesn't lose information; the meter sums the rounded values.
  return Math.round(usd * 100 * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------

export interface LlmMeter {
  input_tokens: number;
  output_tokens: number;
  /** Cumulative estimated USD cents (fractional). */
  cents: number;
}

export function newLlmMeter(): LlmMeter {
  return { input_tokens: 0, output_tokens: 0, cents: 0 };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when the model response cannot be coerced into a valid
 * RoundReturn even after the single permitted re-prompt. The trio runner
 * catches this via round-runner and marks the round regressed.
 */
export class LlmExecutorError extends Error {
  constructor(
    message: string,
    public readonly raw_body: string,
  ) {
    super(message);
    this.name = 'LlmExecutorError';
  }
}

// ---------------------------------------------------------------------------
// Options + minimal model-call surface
// ---------------------------------------------------------------------------

/**
 * Minimal call surface the executor needs from the model layer. Defined
 * narrowly so tests can inject a stub without standing up a real
 * ModelRouter / provider tree.
 */
export interface PlanModelClient {
  call(params: CreateMessageParams): Promise<ModelResponse>;
}

/** Adapt a real ModelRouter into the narrow PlanModelClient shape. */
export function modelClientFromRouter(
  router: ModelRouter,
  taskType: 'orchestrator' | 'planning' | 'memory_extraction' = 'planning',
): PlanModelClient {
  return {
    call: async (params: CreateMessageParams): Promise<ModelResponse> => {
      const provider: ModelProvider = await router.getProvider(taskType);
      return provider.createMessage(params);
    },
  };
}

export interface LlmExecutorOptions {
  /** Model id as the project's router expects (e.g. 'claude-haiku-4-5-20251001'). */
  model: string;
  /** Per-call hard budget for output tokens; re-prompts count toward this. */
  maxOutputTokens?: number;
  /** Per-call wall-clock ceiling in ms. */
  timeoutMs?: number;
  /** Accumulated token + cent tracker; shared across rounds in a phase. */
  meter?: LlmMeter;
  /** For rounds OTHER than 'plan', delegate to this fallback executor. */
  fallback: RoundExecutor;
  /** Underlying model client (typically `modelClientFromRouter`). */
  client: PlanModelClient;
  /**
   * Optional sampling temperature. Defaults to 0.2 — plan rounds want
   * convergent JSON, not creative variance.
   */
  temperature?: number;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 2000;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_TEMPERATURE = 0.2;

// ---------------------------------------------------------------------------
// JSON extraction + structural validation
// ---------------------------------------------------------------------------

const FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)```/;

interface ParseOk {
  ok: true;
  value: RoundReturn;
}
interface ParseErr {
  ok: false;
  reason: string;
}
type ParseResult = ParseOk | ParseErr;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Lift the first ```json ... ``` block out of `body` and validate it
 * matches the shape RoundReturn requires. The validator is intentionally
 * duplicated from `round-runner.ts` (rather than refactored to share a
 * single helper) because Phase 6.9's scope is strictly additive — the
 * round-runner refactor is a separate piece of cleanup. TODO(phase-7+):
 * consolidate these two validators into a single source of truth.
 */
function parseAndValidate(body: string, brief: RoundBrief): ParseResult {
  const fenceMatch = FENCE_RE.exec(body);
  let jsonText: string;
  if (fenceMatch) {
    jsonText = fenceMatch[1].trim();
  } else {
    // Fall back to "the whole body is JSON" — Haiku sometimes drops the
    // fence under terse prompts. This is forgiving; the validator below
    // catches truly malformed shapes.
    jsonText = body.trim();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, reason: `JSON.parse failed: ${(err as Error).message}` };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'parsed JSON is not an object' };
  }
  const r = raw as Partial<RoundReturn>;
  const validStatuses: RoundStatus[] = ['continue', 'needs-input', 'blocked', 'done'];
  if (!validStatuses.includes(r.status as RoundStatus)) {
    return { ok: false, reason: `status invalid: ${String(r.status)}` };
  }
  if (typeof r.summary !== 'string' || r.summary.length === 0) {
    return { ok: false, reason: 'summary missing or empty' };
  }
  if (!isStringArray(r.findings_written)) {
    return { ok: false, reason: 'findings_written must be a string[]' };
  }
  if (!isStringArray(r.commits)) {
    return { ok: false, reason: 'commits must be a string[]' };
  }
  if (
    r.next_round_brief !== undefined &&
    typeof r.next_round_brief !== 'string'
  ) {
    return { ok: false, reason: 'next_round_brief must be a string when present' };
  }
  // Plan-round contract: status='continue' MUST carry a non-empty next_round_brief.
  if (
    brief.kind === 'plan' &&
    r.status === 'continue' &&
    (typeof r.next_round_brief !== 'string' || r.next_round_brief.trim().length === 0)
  ) {
    return {
      ok: false,
      reason: "status='continue' requires a non-empty next_round_brief",
    };
  }
  return { ok: true, value: r as RoundReturn };
}

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

function buildSystemPrompt(brief: RoundBrief): string {
  const lens = getLens(brief.mode);
  const verbsText = lens.mcp_verbs.length > 0 ? lens.mcp_verbs.join('\n') : 'none';
  return PLAN_SYSTEM_PROMPT_TEMPLATE
    .replace(MODE_LENS_MARKER, lens.plan_brief_preamble)
    .replace(MCP_VERBS_MARKER, verbsText);
}

function buildUserMessage(brief: RoundBrief): string {
  return [
    `Trio: ${brief.trio_id}`,
    `Mode: ${brief.mode}`,
    `Goal: ${brief.goal}`,
    '',
    '## Phase brief',
    brief.body,
  ].join('\n');
}

const RETRY_NUDGE =
  'Your previous response did not parse as the required JSON block. Return ONLY the JSON object in a ```json fence, nothing else.';

// ---------------------------------------------------------------------------
// Wall-clock guard
// ---------------------------------------------------------------------------

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutP = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeoutP]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build a `RoundExecutor` whose `plan` rounds hit a real LLM and whose
 * `impl` / `qa` rounds delegate to `opts.fallback`. The executor:
 *
 *   1. Composes a system prompt from the mode-lens preamble + the
 *      RoundReturn contract + a JSON-only fence instruction.
 *   2. Composes the user message from `brief.body` plus goal/mode/trio.
 *   3. Calls `opts.client.call` with `model`, `maxOutputTokens`, a
 *      strict `temperature`, and the wall-clock guard.
 *   4. Updates `opts.meter` (input + output tokens, estimated cents).
 *   5. Extracts the first ```json fence, parses, validates the
 *      RoundReturn shape (including the plan-round constraint that
 *      `status='continue'` requires a non-empty `next_round_brief`).
 *   6. On parse failure, RETRIES ONCE with an appended user nudge.
 *      Second failure -> `LlmExecutorError` (the trio runner converts
 *      this into a regressed outcome via round-runner).
 *
 * Future phases will extend this to impl rounds (which intersect
 * `safeSelfCommit` and the path-trust tiers) and qa rounds (which need
 * a test-runner sandbox). Today: plan only.
 */
export function makeLlmPlanExecutor(opts: LlmExecutorOptions): RoundExecutor {
  const maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const meter = opts.meter;

  const callOnce = async (
    brief: RoundBrief,
    retryAppendix: string | null,
  ): Promise<{ body: string; response: ModelResponse }> => {
    const messages: ModelMessage[] = [
      { role: 'user', content: buildUserMessage(brief) },
    ];
    if (retryAppendix) {
      messages.push({ role: 'user', content: retryAppendix });
    }
    const params: CreateMessageParams = {
      model: opts.model,
      system: buildSystemPrompt(brief),
      messages,
      maxTokens: maxOutputTokens,
      temperature,
    };
    const response = await withTimeout(
      opts.client.call(params),
      timeoutMs,
      `llm-plan-executor:${brief.trio_id}`,
    );
    if (meter) {
      meter.input_tokens += response.inputTokens;
      meter.output_tokens += response.outputTokens;
      meter.cents += estimateCostCents(response.inputTokens, response.outputTokens);
    }
    logger.info(
      {
        trio_id: brief.trio_id,
        kind: brief.kind,
        model: opts.model,
        input_tokens: response.inputTokens,
        output_tokens: response.outputTokens,
        meter_cents: meter ? Number(meter.cents.toFixed(4)) : undefined,
        retry: retryAppendix !== null,
      },
      'autonomy.llm_executor.call',
    );
    return { body: response.content, response };
  };

  return {
    async run(brief: RoundBrief): Promise<RoundReturn> {
      if (brief.kind !== 'plan') {
        return opts.fallback.run(brief);
      }

      const first = await callOnce(brief, null);
      const firstParse = parseAndValidate(first.body, brief);
      if (firstParse.ok) {
        return firstParse.value;
      }
      logger.warn(
        {
          trio_id: brief.trio_id,
          kind: brief.kind,
          reason: firstParse.reason,
        },
        'autonomy.llm_executor.parse_failed.retry',
      );

      const second = await callOnce(brief, RETRY_NUDGE);
      const secondParse = parseAndValidate(second.body, brief);
      if (secondParse.ok) {
        return secondParse.value;
      }

      logger.error(
        {
          trio_id: brief.trio_id,
          kind: brief.kind,
          first_reason: firstParse.reason,
          second_reason: secondParse.reason,
        },
        'autonomy.llm_executor.parse_failed.terminal',
      );
      throw new LlmExecutorError(
        `LLM plan round failed validation after retry: ${secondParse.reason}`,
        second.body,
      );
    },
  };
}
