/**
 * Trio primitive tests.
 *
 * No real LLM calls. A `StubExecutor` returns scripted `RoundReturn`s by
 * `(kind, callIndex)`. Covers the spec's control-flow rules end to end.
 *
 * Choice (documented for Phase 3): when a round return fails validation
 * twice in a row, round-runner throws `RoundReturnParseError` and the
 * trio surfaces this as `outcome='regressed'` with the parse reason as
 * `result.reason` — never crashes the trio runner. This keeps the trio
 * shape uniform: every failure mode resolves to a typed `TrioOutcome`.
 */

import { describe, it, expect, vi } from 'vitest';
import { runTrio } from '../trio.js';
import type {
  AbortSignalSource,
  RoundBrief,
  RoundExecutor,
  RoundKind,
  RoundReturn,
  TrioInput,
} from '../types.js';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

class StubExecutor implements RoundExecutor {
  /** Calls per round kind, in order */
  public calls: RoundBrief[] = [];

  constructor(
    private readonly script: Partial<Record<RoundKind, RoundReturn[]>>,
    /** If set, every executor call awaits this many ms first */
    private readonly delayMs: number = 0,
  ) {}

  async run(brief: RoundBrief): Promise<RoundReturn> {
    this.calls.push(brief);
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    const queue = this.script[brief.kind] ?? [];
    const idx = this.calls.filter((c) => c.kind === brief.kind).length - 1;
    const ret = queue[idx];
    if (!ret) {
      throw new Error(
        `StubExecutor: no scripted return for ${brief.kind} call #${idx + 1}`,
      );
    }
    return ret;
  }
}

function baseInput(over: Partial<TrioInput> = {}): TrioInput {
  return {
    trio_id: 't-1',
    mode: 'plumbing',
    goal: 'unstick the failing-trigger sweep',
    initial_plan_brief: 'plan brief body',
    ...over,
  };
}

const planContinue: RoundReturn = {
  status: 'continue',
  summary: 'plan ok',
  next_round_brief: 'impl this thing',
  findings_written: ['f1'],
  commits: [],
};

const implContinue: RoundReturn = {
  status: 'continue',
  summary: 'impl ok',
  next_round_brief: 'check the thing',
  findings_written: ['f2'],
  commits: ['abc1234'],
};

const qaPassed: RoundReturn = {
  status: 'continue',
  summary: 'qa ok',
  findings_written: [],
  commits: [],
  evaluation: {
    verdict: 'passed',
    criteria: [{ criterion: 'tests green', outcome: 'passed' }],
    test_commits: ['def5678'],
    fix_commits: [],
  },
};

const qaFailedFixed: RoundReturn = {
  ...qaPassed,
  evaluation: {
    verdict: 'failed-fixed',
    criteria: [{ criterion: 'broken then patched', outcome: 'passed' }],
    test_commits: ['def5678'],
    fix_commits: ['fix9999'],
  },
};

const qaFailedEscalate: RoundReturn = {
  ...qaPassed,
  evaluation: {
    verdict: 'failed-escalate',
    criteria: [{ criterion: 'still broken', outcome: 'failed' }],
    test_commits: ['def5678'],
    fix_commits: [],
  },
};

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('runTrio — happy path', () => {
  it('plan -> impl -> qa(passed) marks the trio successful with three rounds', async () => {
    const exec = new StubExecutor({
      plan: [planContinue],
      impl: [implContinue],
      qa: [qaPassed],
    });
    const result = await runTrio(baseInput(), exec);

    expect(result.outcome).toBe('successful');
    expect(result.rounds).toHaveLength(3);
    expect(result.rounds.map((r) => r.kind)).toEqual(['plan', 'impl', 'qa']);
    expect(result.qa_evaluation?.verdict).toBe('passed');
    // Brief threading: impl receives plan's normalised return as `prior`, qa
    // receives impl's. round-runner returns a new object (it normalises the
    // summary), so identity will differ; deep-equal is the right check.
    expect(result.rounds[1].brief.prior).toStrictEqual(result.rounds[0].ret);
    expect(result.rounds[2].brief.prior).toStrictEqual(result.rounds[1].ret);
    // Impl body comes from plan.next_round_brief; qa body from impl's
    expect(result.rounds[1].brief.body).toBe('impl this thing');
    expect(result.rounds[2].brief.body).toBe('check the thing');
  });
});

describe('runTrio — qa verdict mapping', () => {
  it('failed-fixed counts as successful (the fix landed)', async () => {
    const exec = new StubExecutor({
      plan: [planContinue],
      impl: [implContinue],
      qa: [qaFailedFixed],
    });
    const result = await runTrio(baseInput(), exec);

    expect(result.outcome).toBe('successful');
    expect(result.qa_evaluation?.verdict).toBe('failed-fixed');
  });

  it('failed-escalate marks the trio regressed', async () => {
    const exec = new StubExecutor({
      plan: [planContinue],
      impl: [implContinue],
      qa: [qaFailedEscalate],
    });
    const result = await runTrio(baseInput(), exec);

    expect(result.outcome).toBe('regressed');
    expect(result.reason).toContain('failed-escalate');
    expect(result.qa_evaluation?.verdict).toBe('failed-escalate');
  });
});

describe('runTrio — plan branches', () => {
  it('plan needs-input -> awaiting-founder; impl + qa NOT spawned; founder hook called once', async () => {
    const planAsk: RoundReturn = {
      status: 'needs-input',
      summary: 'should I do A or B?',
      findings_written: [],
      commits: [],
    };
    const exec = new StubExecutor({ plan: [planAsk] });
    const onFounderQuestion = vi.fn().mockResolvedValue(undefined);

    const result = await runTrio(
      baseInput({ onFounderQuestion }),
      exec,
    );

    expect(result.outcome).toBe('awaiting-founder');
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].kind).toBe('plan');
    expect(onFounderQuestion).toHaveBeenCalledTimes(1);
    const call = onFounderQuestion.mock.calls[0][0];
    expect(call.round).toBe('plan');
    expect(call.brief.kind).toBe('plan');
    // Ret is the normalised return from round-runner (new object, same content).
    expect(call.ret).toStrictEqual(planAsk);
    // No impl/qa attempts
    expect(exec.calls.filter((c) => c.kind === 'impl')).toHaveLength(0);
    expect(exec.calls.filter((c) => c.kind === 'qa')).toHaveLength(0);
  });

  it('plan continue without next_round_brief -> regressed with specific reason', async () => {
    const planBad: RoundReturn = {
      status: 'continue',
      summary: 'forgot the brief',
      findings_written: [],
      commits: [],
    };
    const exec = new StubExecutor({ plan: [planBad] });
    const result = await runTrio(baseInput(), exec);

    expect(result.outcome).toBe('regressed');
    expect(result.reason).toBe('plan returned continue without next_round_brief');
    expect(exec.calls.filter((c) => c.kind === 'impl')).toHaveLength(0);
  });
});

describe('runTrio — impl branches', () => {
  it('impl blocked -> regressed; qa NOT spawned', async () => {
    const implBlocked: RoundReturn = {
      status: 'blocked',
      summary: 'cannot proceed: env missing',
      findings_written: [],
      commits: [],
    };
    const exec = new StubExecutor({
      plan: [planContinue],
      impl: [implBlocked],
    });
    const result = await runTrio(baseInput(), exec);

    expect(result.outcome).toBe('regressed');
    expect(result.reason).toContain('cannot proceed');
    expect(exec.calls.filter((c) => c.kind === 'qa')).toHaveLength(0);
  });
});

describe('runTrio — abort source', () => {
  it('abort raised before plan -> blocked, executor never called', async () => {
    const exec = new StubExecutor({});
    const abort: AbortSignalSource = {
      poll: () => ({ reason: 'pulse regression' }),
    };
    const result = await runTrio(baseInput({ abort }), exec);

    expect(result.outcome).toBe('blocked');
    expect(result.reason).toBe('pulse regression');
    expect(exec.calls).toHaveLength(0);
  });

  it('abort raised between impl and qa -> blocked; qa not spawned; impl recorded', async () => {
    let pollCount = 0;
    const abort: AbortSignalSource = {
      poll: () => {
        pollCount++;
        // Boundary 0 (pre-plan) and Boundary 1 (pre-impl) clean;
        // Boundary 2 (pre-qa) raises.
        if (pollCount >= 3) return { reason: 'cap exceeded' };
        return null;
      },
    };
    const exec = new StubExecutor({
      plan: [planContinue],
      impl: [implContinue],
    });
    const result = await runTrio(baseInput({ abort }), exec);

    expect(result.outcome).toBe('blocked');
    expect(result.reason).toBe('cap exceeded');
    expect(result.rounds.map((r) => r.kind)).toEqual(['plan', 'impl']);
    expect(exec.calls.filter((c) => c.kind === 'qa')).toHaveLength(0);
  });
});

describe('runTrio — wall clock', () => {
  it('max_minutes=0 with a slow executor -> blocked, reason wall_clock_exceeded', async () => {
    const exec = new StubExecutor(
      {
        plan: [planContinue],
        impl: [implContinue],
        qa: [qaPassed],
      },
      20, // 20ms per round; even one round blows the 0-minute budget
    );
    const result = await runTrio(baseInput({ max_minutes: 0 }), exec);

    expect(result.outcome).toBe('blocked');
    expect(result.reason).toBe('wall_clock_exceeded');
    // Plan ran (Boundary 0 checks BEFORE plan starts; budget was at 0 but
    // elapsed was 0ms too. Boundary 1 runs after plan and trips). So we
    // expect at least the plan in the recorded rounds.
    expect(result.rounds.length).toBeGreaterThanOrEqual(1);
    expect(result.rounds[0].kind).toBe('plan');
    // QA must NOT have run.
    expect(exec.calls.filter((c) => c.kind === 'qa')).toHaveLength(0);
  });
});

describe('runTrio — onRoundComplete', () => {
  it('fires once per spawned round in order with persisted brief + return', async () => {
    const exec = new StubExecutor({
      plan: [planContinue],
      impl: [implContinue],
      qa: [qaPassed],
    });
    const persisted: Array<{ kind: RoundKind; status: string }> = [];
    const onRoundComplete = vi.fn(async (b: RoundBrief, r: RoundReturn) => {
      persisted.push({ kind: b.kind, status: r.status });
    });

    const result = await runTrio(baseInput({ onRoundComplete }), exec);

    expect(result.outcome).toBe('successful');
    expect(onRoundComplete).toHaveBeenCalledTimes(3);
    expect(persisted).toEqual([
      { kind: 'plan', status: 'continue' },
      { kind: 'impl', status: 'continue' },
      { kind: 'qa', status: 'continue' },
    ]);
    // Briefs/returns must be the same identities as in the result rounds
    for (let i = 0; i < 3; i++) {
      expect(onRoundComplete.mock.calls[i][0]).toBe(result.rounds[i].brief);
      expect(onRoundComplete.mock.calls[i][1]).toBe(result.rounds[i].ret);
    }
  });
});

describe('runTrio — round-runner validation', () => {
  it('plan missing findings_written -> re-prompt once, then if still missing surfaces as regressed', async () => {
    // Bad return shape. Cast through unknown so we can hand the executor
    // a deliberately invalid object to exercise the validator.
    const planMissingFindings = {
      status: 'continue',
      summary: 'plan ok',
      next_round_brief: 'impl this',
      commits: [],
      // findings_written intentionally absent
    } as unknown as RoundReturn;

    const exec = new StubExecutor({
      plan: [planMissingFindings, planMissingFindings],
    });

    const result = await runTrio(baseInput(), exec);

    // Two plan calls (original + re-prompt), no impl/qa
    expect(exec.calls.filter((c) => c.kind === 'plan')).toHaveLength(2);
    expect(exec.calls.filter((c) => c.kind === 'impl')).toHaveLength(0);
    // Re-prompt brief carries the "Return ONLY the structured block." marker
    expect(exec.calls[1].body).toContain('Return ONLY the structured block.');

    expect(result.outcome).toBe('regressed');
    expect(result.reason).toContain('findings_written');
  });

  it('re-prompt success on second try is accepted and the trio continues', async () => {
    const planBad = {
      status: 'continue',
      summary: 'plan ok',
      next_round_brief: 'impl this',
      commits: [],
    } as unknown as RoundReturn;

    const exec = new StubExecutor({
      plan: [planBad, planContinue],
      impl: [implContinue],
      qa: [qaPassed],
    });

    const result = await runTrio(baseInput(), exec);

    expect(result.outcome).toBe('successful');
    expect(exec.calls.filter((c) => c.kind === 'plan')).toHaveLength(2);
  });
});
