/**
 * Unit tests for the real-LLM plan executor.
 *
 * The model client is stubbed via dependency injection so these tests
 * never hit a real model — they're <200ms and CI-safe. The real-LLM
 * scenario lives under `src/autonomy/eval/scenarios-llm/` and is run
 * only when `OHWOW_AUTONOMY_EVAL_REAL=1` + `--real`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  LlmExecutorError,
  SpendCapExceeded,
  estimateCostCents,
  makeLlmPlanExecutor,
  makeQaJudgeExecutor,
  newLlmMeter,
  type LlmMeter,
  type PlanModelClient,
} from '../llm-executor.js';
import type {
  CreateMessageParams,
  ModelResponse,
} from '../../../execution/model-router.js';
import type { RoundBrief, RoundExecutor, RoundReturn } from '../../types.js';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeBrief(kind: 'plan' | 'impl' | 'qa' = 'plan'): RoundBrief {
  return {
    trio_id: 'trio_test',
    kind,
    mode: 'revenue',
    goal: 'fire approval ap_demo',
    body: 'Pending approval ap_demo for an X DM draft. Read it then approve / reject.',
  };
}

function makeStubClient(
  responses: Array<{ content: string; inputTokens?: number; outputTokens?: number }>,
): { client: PlanModelClient; calls: CreateMessageParams[] } {
  const calls: CreateMessageParams[] = [];
  let i = 0;
  const client: PlanModelClient = {
    call: async (params: CreateMessageParams): Promise<ModelResponse> => {
      calls.push(params);
      const r = responses[i++];
      if (!r) throw new Error(`stub client: no scripted response for call #${i}`);
      return {
        content: r.content,
        inputTokens: r.inputTokens ?? 100,
        outputTokens: r.outputTokens ?? 50,
        model: params.model ?? 'stub',
        provider: 'anthropic',
      };
    },
  };
  return { client, calls };
}

const PASS_FALLBACK: RoundExecutor = {
  async run(brief: RoundBrief): Promise<RoundReturn> {
    if (brief.kind === 'qa') {
      return {
        status: 'continue',
        summary: 'fallback qa pass',
        findings_written: [],
        commits: [],
        evaluation: {
          verdict: 'passed',
          criteria: [{ criterion: 'fallback', outcome: 'passed' }],
          test_commits: [],
          fix_commits: [],
        },
      };
    }
    return {
      status: 'continue',
      summary: `fallback ${brief.kind}`,
      next_round_brief: 'fallback brief',
      findings_written: [],
      commits: [],
    };
  },
};

const VALID_PLAN_JSON = JSON.stringify({
  status: 'continue',
  summary: 'Read approval ap_demo, then approve via MCP.',
  next_round_brief:
    'Run ohwow_preview_approval(ap_demo); if subject reads cleanly, approve via ohwow_approve_x_draft(ap_demo).',
  findings_written: [],
  commits: [],
});

const VALID_PLAN_FENCED = '```json\n' + VALID_PLAN_JSON + '\n```';

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('estimateCostCents', () => {
  it('computes Haiku pricing per million tokens', () => {
    // 1M input tokens * $1 + 1M output tokens * $5 = $6 = 600 cents
    expect(estimateCostCents(1_000_000, 1_000_000)).toBeCloseTo(600, 4);
    // 1000 input + 500 output = ~ (0.001*100 + 0.0005*500) cents
    const c = estimateCostCents(1000, 500);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(1);
  });
});

describe('makeLlmPlanExecutor', () => {
  it('parses a valid fenced JSON response on first attempt', async () => {
    const { client, calls } = makeStubClient([{ content: VALID_PLAN_FENCED }]);
    const meter = newLlmMeter();
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
      meter,
    });
    const ret = await exec.run(makeBrief('plan'));
    expect(ret.status).toBe('continue');
    expect(ret.next_round_brief).toContain('ohwow_preview_approval');
    expect(calls).toHaveLength(1);
    // System prompt should include the role line and the revenue lens preamble.
    expect(calls[0].system).toContain('You are the PLAN round of an autonomy trio');
    expect(calls[0].system).toContain('MODE: revenue');
  });

  it('accepts unfenced JSON when the model drops the fence', async () => {
    const { client } = makeStubClient([{ content: VALID_PLAN_JSON }]);
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });
    const ret = await exec.run(makeBrief('plan'));
    expect(ret.status).toBe('continue');
  });

  it('retries once on prose-wrapped output, succeeds on second attempt', async () => {
    const { client, calls } = makeStubClient([
      { content: 'Sure, here is the plan:\n\nIt is going to be great.' },
      { content: VALID_PLAN_FENCED },
    ]);
    const meter = newLlmMeter();
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
      meter,
    });
    const ret = await exec.run(makeBrief('plan'));
    expect(ret.status).toBe('continue');
    expect(calls).toHaveLength(2);
    // Second call appends the retry nudge as an extra user message.
    const lastMsg = calls[1].messages[calls[1].messages.length - 1];
    expect(typeof lastMsg.content).toBe('string');
    expect(lastMsg.content).toMatch(/JSON fence/i);
    // Meter accumulates across both calls.
    expect(meter.input_tokens).toBe(200);
    expect(meter.output_tokens).toBe(100);
    expect(meter.cents).toBeGreaterThan(0);
  });

  it('throws LlmExecutorError after second parse failure', async () => {
    const { client } = makeStubClient([
      { content: 'first prose with no JSON' },
      { content: 'still prose, still no JSON' },
    ]);
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });
    await expect(exec.run(makeBrief('plan'))).rejects.toBeInstanceOf(
      LlmExecutorError,
    );
  });

  it('rejects continue without a non-empty next_round_brief', async () => {
    const bad = JSON.stringify({
      status: 'continue',
      summary: 'plan',
      // next_round_brief intentionally missing
      findings_written: [],
      commits: [],
    });
    const { client } = makeStubClient([
      { content: '```json\n' + bad + '\n```' },
      { content: '```json\n' + bad + '\n```' },
    ]);
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });
    await expect(exec.run(makeBrief('plan'))).rejects.toBeInstanceOf(
      LlmExecutorError,
    );
  });

  it('delegates non-plan kinds to the fallback executor', async () => {
    const { client, calls } = makeStubClient([]); // would throw if called
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });
    const implRet = await exec.run(makeBrief('impl'));
    expect(implRet.summary).toBe('fallback impl');
    const qaRet = await exec.run(makeBrief('qa'));
    expect(qaRet.evaluation?.verdict).toBe('passed');
    expect(calls).toHaveLength(0);
  });

  it('shares one meter across multiple plan calls', async () => {
    const { client } = makeStubClient([
      { content: VALID_PLAN_FENCED, inputTokens: 100, outputTokens: 50 },
      { content: VALID_PLAN_FENCED, inputTokens: 200, outputTokens: 80 },
    ]);
    const meter: LlmMeter = newLlmMeter();
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
      meter,
    });
    await exec.run(makeBrief('plan'));
    await exec.run(makeBrief('plan'));
    expect(meter.input_tokens).toBe(300);
    expect(meter.output_tokens).toBe(130);
    expect(meter.cents).toBeGreaterThan(0);
  });
});

// ----------------------------------------------------------------------------
// Regression tests: MCP_VERBS injection into PLAN system prompt (gap 14.3)
//
// These tests verify that buildSystemPrompt() splices the correct verb list
// for each mode via MCP_VERBS_MARKER, and that the placement and
// MODE_LENS_MARKER substitution are both intact.
// ----------------------------------------------------------------------------

import type { Mode } from '../../types.js';

/**
 * Build a RoundBrief for an arbitrary mode so we can inspect what
 * buildSystemPrompt() produces for that mode without running a real model.
 * The stub client captures `params.system` from the first call.
 */
async function captureSystemPrompt(mode: Mode): Promise<string> {
  let capturedSystem: string | undefined;
  const client: PlanModelClient = {
    call: async (params: CreateMessageParams): Promise<ModelResponse> => {
      capturedSystem = params.system;
      // Return a valid fenced response so the executor doesn't throw.
      return {
        content: VALID_PLAN_FENCED,
        inputTokens: 10,
        outputTokens: 10,
        model: 'stub',
        provider: 'anthropic',
      };
    },
  };
  const exec = makeLlmPlanExecutor({
    model: 'stub',
    client,
    fallback: PASS_FALLBACK,
  });
  await exec.run({ trio_id: 'trio_verbs_test', kind: 'plan', mode, goal: 'test', body: 'test' });
  if (capturedSystem === undefined) throw new Error('system prompt was not captured');
  return capturedSystem;
}

describe('buildSystemPrompt — MCP_VERBS injection (gap 14.3 regression)', () => {
  // Criterion 1: revenue mode injects all revenue verbs.
  // ohwow_approve_x_draft and ohwow_draft_x_dm removed 2026-04-19 (X account banned).
  it('revenue: contains all revenue mcp_verbs', async () => {
    const sys = await captureSystemPrompt('revenue');
    expect(sys).toContain('ohwow_list_approvals');
    expect(sys).toContain('ohwow_preview_approval');
    expect(sys).toContain('ohwow_update_deal');
    expect(sys).toContain('ohwow_pipeline_summary');
    expect(sys).toContain('ohwow_revenue_summary');
  });

  // Criterion 2: plumbing mode injects all 3 plumbing verbs
  it('plumbing: contains all 3 plumbing mcp_verbs', async () => {
    const sys = await captureSystemPrompt('plumbing');
    expect(sys).toContain('ohwow_list_failing_triggers');
    expect(sys).toContain('ohwow_daemon_status');
    expect(sys).toContain('ohwow_workspace_status');
  });

  // Criterion 3: polish mode (empty mcp_verbs) injects the literal 'none'
  it('polish: injects literal "none" when mcp_verbs is empty', async () => {
    const sys = await captureSystemPrompt('polish');
    expect(sys).toContain('none');
    // Must NOT contain a real verb (sanity: no cross-lens bleed)
    expect(sys).not.toContain('ohwow_list_approvals');
    expect(sys).not.toContain('ohwow_daemon_status');
  });

  // Criterion 4: tooling mode (empty mcp_verbs) injects the literal 'none'
  it('tooling: injects literal "none" when mcp_verbs is empty', async () => {
    const sys = await captureSystemPrompt('tooling');
    expect(sys).toContain('none');
    expect(sys).not.toContain('ohwow_list_approvals');
    expect(sys).not.toContain('ohwow_daemon_status');
  });

  // Criterion 5: verb section appears BETWEEN the mode lens block and the output contract
  it('placement: AVAILABLE MCP VERBS appears after MODE LENS and before OUTPUT CONTRACT', async () => {
    const sys = await captureSystemPrompt('revenue');
    const modeLensPos = sys.indexOf('MODE LENS');
    const verbsPos = sys.indexOf('AVAILABLE MCP VERBS');
    const outputContractPos = sys.indexOf('OUTPUT CONTRACT');
    expect(modeLensPos).toBeGreaterThan(-1);
    expect(verbsPos).toBeGreaterThan(-1);
    expect(outputContractPos).toBeGreaterThan(-1);
    expect(verbsPos).toBeGreaterThan(modeLensPos);
    expect(outputContractPos).toBeGreaterThan(verbsPos);
  });

  // Criterion 7: MODE_LENS_MARKER replacement is still functional (regression)
  it('MODE_LENS_MARKER replacement: mode-specific preamble is present in rendered prompt', async () => {
    const revSys = await captureSystemPrompt('revenue');
    // revenue preamble starts with "MODE: revenue."
    expect(revSys).toContain('MODE: revenue');

    const plumbSys = await captureSystemPrompt('plumbing');
    expect(plumbSys).toContain('MODE: plumbing');

    const polishSys = await captureSystemPrompt('polish');
    expect(polishSys).toContain('MODE: polish');

    const toolingSys = await captureSystemPrompt('tooling');
    expect(toolingSys).toContain('MODE: tooling');

    // Confirm the raw marker is NOT in any rendered prompt
    expect(revSys).not.toContain('{{MODE_LENS}}');
    expect(revSys).not.toContain('{{MCP_VERBS}}');
  });
});

// ----------------------------------------------------------------------------
// Transient network error retry (gap ECONNRESET fix — 634355a regression)
//
// These tests verify that callOnce inside makeLlmPlanExecutor retries once
// on transient network errors (ECONNRESET, fetch failed, ECONNREFUSED) with
// a 2-second backoff, and that non-transient errors propagate immediately.
// Fake timers are used so the 2s delay does not slow down CI.
// ----------------------------------------------------------------------------

/**
 * Build a stub client that throws the given error on the first call and
 * returns a valid response on the second. If secondError is provided, both
 * calls throw.
 */
function makeThrowingClient(
  firstError: Error,
  secondResponse:
    | { content: string; inputTokens?: number; outputTokens?: number }
    | Error,
): { client: PlanModelClient; callCount: () => number } {
  let count = 0;
  const client: PlanModelClient = {
    call: async (): Promise<ModelResponse> => {
      count++;
      if (count === 1) throw firstError;
      if (secondResponse instanceof Error) throw secondResponse;
      return {
        content: secondResponse.content,
        inputTokens: secondResponse.inputTokens ?? 100,
        outputTokens: secondResponse.outputTokens ?? 50,
        model: 'stub',
        provider: 'anthropic',
      };
    },
  };
  return { client, callCount: () => count };
}

describe('transient network error retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Criterion: ECONNRESET on first call -> retry once -> success
  it('retries once on ECONNRESET and succeeds if second call succeeds', async () => {
    const econnreset = new Error('read ECONNRESET');
    const { client, callCount } = makeThrowingClient(econnreset, {
      content: VALID_PLAN_FENCED,
    });
    const meter = newLlmMeter();
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
      meter,
    });

    const runPromise = exec.run(makeBrief('plan'));
    // Advance past the 2s backoff so the retry fires.
    await vi.runAllTimersAsync();
    const ret = await runPromise;

    expect(ret.status).toBe('continue');
    expect(callCount()).toBe(2);
    // Meter should reflect the one successful call (first threw before billing).
    expect(meter.input_tokens).toBeGreaterThan(0);
  });

  // Criterion: ECONNRESET on both calls -> error propagates
  // Note: this test uses real timers (vi.useRealTimers) to avoid a Vitest
  // unhandled-rejection edge case when fake timers are active and both
  // calls throw. The 2s delay makes this test slow so we override timeoutMs
  // to 0 — the retry fires immediately.
  it('propagates error when both first and second calls throw ECONNRESET', async () => {
    vi.useRealTimers();
    const econnreset1 = new Error('read ECONNRESET');
    const econnreset2 = new Error('read ECONNRESET');
    const { client, callCount } = makeThrowingClient(econnreset1, econnreset2);
    // Use retryDelayMs override: since isTransientNetworkError fires a 2s
    // setTimeout we skip the delay by pointing timeoutMs to a very large
    // value (the wall-clock guard) and relying on the real event loop.
    // We override the internal delay by setting a 0-length timeout via a
    // custom stub that replaces setTimeout for this one test.
    const origSetTimeout = globalThis.setTimeout;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (fn: (...args: unknown[]) => void, _delay?: number) =>
        origSetTimeout(fn, 0),
    );
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });

    try {
      await expect(exec.run(makeBrief('plan'))).rejects.toThrow('ECONNRESET');
      expect(callCount()).toBe(2);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  // Criterion: SpendCapExceeded is never retried
  it('propagates SpendCapExceeded immediately without retry', async () => {
    let count = 0;
    const client: PlanModelClient = {
      call: async (): Promise<ModelResponse> => {
        count++;
        throw new SpendCapExceeded(100, 50);
      },
    };
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });

    await expect(exec.run(makeBrief('plan'))).rejects.toBeInstanceOf(SpendCapExceeded);
    // Should have thrown on the first call — no retry.
    expect(count).toBe(1);
  });

  // Criterion: non-transient errors (e.g. generic LlmExecutorError) propagate immediately
  it('propagates non-transient errors immediately without retry', async () => {
    let count = 0;
    const client: PlanModelClient = {
      call: async (): Promise<ModelResponse> => {
        count++;
        throw new Error('HTTP 500 Internal Server Error');
      },
    };
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });

    await expect(exec.run(makeBrief('plan'))).rejects.toThrow('HTTP 500');
    expect(count).toBe(1);
  });

  // Criterion: warning log entry is emitted before the retry
  it('emits autonomy.llm_executor.network_retry warning before retrying', async () => {
    const { logger } = await import('../../../lib/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    const econnreset = new Error('read ECONNRESET');
    const { client } = makeThrowingClient(econnreset, { content: VALID_PLAN_FENCED });
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });

    const runPromise = exec.run(makeBrief('plan'));
    await vi.runAllTimersAsync();
    await runPromise;

    const networkRetryCall = warnSpy.mock.calls.find(
      (args) => args[1] === 'autonomy.llm_executor.network_retry',
    );
    expect(networkRetryCall).toBeDefined();
    // First arg should include trio_id and err message.
    const meta = networkRetryCall![0] as Record<string, unknown>;
    expect(meta).toHaveProperty('trio_id', 'trio_test');
    expect(meta).toHaveProperty('err');

    warnSpy.mockRestore();
  });

  // Criterion: 2s delay is included in the retry path (observable via fake timers)
  it('includes a 2s delay between first failure and retry', async () => {
    const econnreset = new Error('fetch failed');
    const { client, callCount } = makeThrowingClient(econnreset, {
      content: VALID_PLAN_FENCED,
    });
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });

    const runPromise = exec.run(makeBrief('plan'));

    // Advance only 1999ms — the retry should NOT have fired yet.
    await vi.advanceTimersByTimeAsync(1999);
    // Still on call 1 (threw); call 2 hasn't been made yet.
    expect(callCount()).toBe(1);

    // Advance past the 2s mark — now the retry fires.
    await vi.advanceTimersByTimeAsync(2);
    await runPromise;
    expect(callCount()).toBe(2);
  });

  // Criterion: isTransientNetworkError returns true for ECONNRESET / fetch failed / ECONNREFUSED
  // (tested indirectly: only these errors trigger a retry)
  it('treats "fetch failed" as transient', async () => {
    const fetchFailed = new Error('fetch failed');
    const { client, callCount } = makeThrowingClient(fetchFailed, {
      content: VALID_PLAN_FENCED,
    });
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });

    const runPromise = exec.run(makeBrief('plan'));
    await vi.runAllTimersAsync();
    const ret = await runPromise;

    expect(ret.status).toBe('continue');
    expect(callCount()).toBe(2);
  });

  it('treats "ECONNREFUSED" as transient', async () => {
    const econnrefused = new Error('connect ECONNREFUSED 127.0.0.1:11434');
    const { client, callCount } = makeThrowingClient(econnrefused, {
      content: VALID_PLAN_FENCED,
    });
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });

    const runPromise = exec.run(makeBrief('plan'));
    await vi.runAllTimersAsync();
    const ret = await runPromise;

    expect(ret.status).toBe('continue');
    expect(callCount()).toBe(2);
  });

  // Criterion: parse-failure retry path unaffected (still works with fake timers active)
  it('parse-failure retry still works when fake timers are active', async () => {
    // First call returns prose (parse failure), second returns valid JSON.
    // The parse-failure retry does NOT sleep — so no timer advance needed.
    let count = 0;
    const client: PlanModelClient = {
      call: async (): Promise<ModelResponse> => {
        count++;
        return {
          content: count === 1 ? 'No JSON here, sorry.' : VALID_PLAN_FENCED,
          inputTokens: 100,
          outputTokens: 50,
          model: 'stub',
          provider: 'anthropic',
        };
      },
    };
    const exec = makeLlmPlanExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });

    const ret = await exec.run(makeBrief('plan'));
    expect(ret.status).toBe('continue');
    expect(count).toBe(2);
  });
});

// ----------------------------------------------------------------------------
// makeQaJudgeExecutor (gap 14.4)
//
// Tests verify: delegation, single LLM call, user-message composition,
// parse-failure retry, double-failure error, and meter accumulation.
// No real model is used — the client is fully stubbed.
// ----------------------------------------------------------------------------

function makeQaBrief(overrides?: {
  body?: string;
  priorSummary?: string;
  priorNextRoundBrief?: string;
}): import('../../types.js').RoundBrief {
  return {
    trio_id: 'trio_qa_test',
    kind: 'qa',
    mode: 'revenue',
    goal: 'fire approval ap_demo',
    body: overrides?.body ?? 'Criterion A: approval was processed.\nCriterion B: DM was sent.',
    prior: {
      status: 'continue',
      summary: overrides?.priorSummary ?? 'Impl ran ohwow_approve_x_draft(ap_demo) successfully.',
      next_round_brief: overrides?.priorNextRoundBrief,
      findings_written: [],
      commits: [],
    },
  };
}

const VALID_QA_JSON = JSON.stringify({
  status: 'continue',
  summary: 'All criteria covered.',
  evaluation: {
    verdict: 'passed',
    criteria: [
      { criterion: 'Criterion A: approval was processed.', outcome: 'covered' },
      { criterion: 'Criterion B: DM was sent.', outcome: 'covered' },
    ],
    rationale: 'The impl summary confirms both criteria were addressed.',
  },
  findings_written: [],
  commits: [],
});

const VALID_QA_FENCED = '```json\n' + VALID_QA_JSON + '\n```';

describe('makeQaJudgeExecutor', () => {
  // (a) Non-qa briefs delegate to fallback without calling the LLM client.
  it('non-qa brief (plan kind) delegates to fallback, client.call never called', async () => {
    const { client, calls } = makeStubClient([]);
    const exec = makeQaJudgeExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });
    const ret = await exec.run(makeBrief('plan'));
    // Fallback returns summary 'fallback plan'
    expect(ret.summary).toBe('fallback plan');
    expect(calls).toHaveLength(0);
  });

  it('non-qa brief (impl kind) delegates to fallback, client.call never called', async () => {
    const { client, calls } = makeStubClient([]);
    const exec = makeQaJudgeExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });
    const ret = await exec.run(makeBrief('impl'));
    expect(ret.summary).toBe('fallback impl');
    expect(calls).toHaveLength(0);
  });

  // (b) QA brief with valid JSON -> single LLM call -> RoundReturn with evaluation.verdict.
  it('qa brief with valid fenced JSON -> single LLM call -> RoundReturn with evaluation.verdict', async () => {
    const { client, calls } = makeStubClient([{ content: VALID_QA_FENCED }]);
    const exec = makeQaJudgeExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });
    const ret = await exec.run(makeQaBrief());
    expect(ret.status).toBe('continue');
    const validVerdicts = ['passed', 'failed-fixed', 'failed-escalate'];
    expect(validVerdicts).toContain(ret.evaluation?.verdict);
    expect(ret.evaluation?.verdict).toBe('passed');
    expect(calls).toHaveLength(1);
  });

  // (c) Criteria from brief.body and impl summary from brief.prior?.summary appear in user message.
  it('user message contains criteria from brief.body and impl summary from brief.prior.summary', async () => {
    const criteriaText = 'Criterion A: approval was processed.\nCriterion B: DM was sent.';
    const implSummary = 'Impl executed approve action and confirmed delivery.';
    const { client, calls } = makeStubClient([{ content: VALID_QA_FENCED }]);
    const exec = makeQaJudgeExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });
    await exec.run(makeQaBrief({ body: criteriaText, priorSummary: implSummary }));
    expect(calls).toHaveLength(1);
    const userMsg = calls[0].messages[0].content as string;
    expect(userMsg).toContain(criteriaText);
    expect(userMsg).toContain(implSummary);
  });

  // (d) First parse failure -> retry -> second parse ok -> resolves.
  it('first parse failure triggers retry; second parse success -> resolves', async () => {
    const { client, calls } = makeStubClient([
      { content: 'Sorry, I cannot provide a JSON response here.' },
      { content: VALID_QA_FENCED },
    ]);
    const exec = makeQaJudgeExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });
    const ret = await exec.run(makeQaBrief());
    expect(ret.status).toBe('continue');
    expect(ret.evaluation?.verdict).toBe('passed');
    // Two calls: first (parse fail) + retry.
    expect(calls).toHaveLength(2);
    // The retry appends a nudge message.
    const retryMessages = calls[1].messages;
    const lastMsg = retryMessages[retryMessages.length - 1];
    expect(typeof lastMsg.content).toBe('string');
    expect(lastMsg.content as string).toMatch(/JSON fence/i);
  });

  // (e) Two parse failures -> throws LlmExecutorError.
  it('two consecutive parse failures -> throws LlmExecutorError', async () => {
    const { client, calls } = makeStubClient([
      { content: 'First invalid prose, no JSON.' },
      { content: 'Second invalid prose, still no JSON.' },
    ]);
    const exec = makeQaJudgeExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });
    await expect(exec.run(makeQaBrief())).rejects.toBeInstanceOf(LlmExecutorError);
    expect(calls).toHaveLength(2);
  });

  // (f) Meter accumulates tokens from the qa call.
  it('meter.cents is incremented after a qa call', async () => {
    const { client } = makeStubClient([
      { content: VALID_QA_FENCED, inputTokens: 300, outputTokens: 100 },
    ]);
    const meter: LlmMeter = newLlmMeter();
    const exec = makeQaJudgeExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
      meter,
    });
    await exec.run(makeQaBrief());
    expect(meter.input_tokens).toBe(300);
    expect(meter.output_tokens).toBe(100);
    expect(meter.cents).toBeGreaterThan(0);
  });

  // Bonus: system prompt is the QA template (not the PLAN template).
  it('system prompt contains QA judge role text', async () => {
    const { client, calls } = makeStubClient([{ content: VALID_QA_FENCED }]);
    const exec = makeQaJudgeExecutor({
      model: 'stub-haiku',
      client,
      fallback: PASS_FALLBACK,
    });
    await exec.run(makeQaBrief());
    expect(calls[0].system).toContain('You are the QA judge for an ohwow autonomy trio');
  });
});
