/**
 * Unit tests for the real-LLM plan executor.
 *
 * The model client is stubbed via dependency injection so these tests
 * never hit a real model — they're <200ms and CI-safe. The real-LLM
 * scenario lives under `src/autonomy/eval/scenarios-llm/` and is run
 * only when `OHWOW_AUTONOMY_EVAL_REAL=1` + `--real`.
 */
import { describe, expect, it } from 'vitest';
import {
  LlmExecutorError,
  estimateCostCents,
  makeLlmPlanExecutor,
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
