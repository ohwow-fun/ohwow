/**
 * Test helpers for the autonomy stack. Phase 3 reuses these across the
 * trio and phase-orchestrator suites so we don't rebuild scripted
 * `RoundExecutor`s in every file.
 */

import type {
  RoundBrief,
  RoundExecutor,
  RoundKind,
  RoundReturn,
} from '../types.js';

export class StubExecutor implements RoundExecutor {
  /** Calls per round kind, in order */
  public calls: RoundBrief[] = [];

  constructor(
    private readonly script: Partial<Record<RoundKind, RoundReturn[]>>,
    /** If set, every executor call awaits this many ms first. */
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

/**
 * Multi-trio scripted executor: each trio gets its own (plan,impl,qa)
 * triple. Trios are identified by `brief.trio_id` so the orchestrator's
 * per-trio brief threading (re-plan, etc.) is preserved.
 */
export class TrioScriptedExecutor implements RoundExecutor {
  public calls: RoundBrief[] = [];
  /** Indexed by trio_id -> { plan: [...], impl: [...], qa: [...] } */
  private readonly byTrio: Map<string, Partial<Record<RoundKind, RoundReturn[]>>>;

  constructor(
    perTrioScripts: Array<Partial<Record<RoundKind, RoundReturn[]>>>,
    private readonly trioIdPrefix: (i: number) => string,
  ) {
    this.byTrio = new Map();
    for (let i = 0; i < perTrioScripts.length; i++) {
      this.byTrio.set(this.trioIdPrefix(i), perTrioScripts[i]);
    }
  }

  async run(brief: RoundBrief): Promise<RoundReturn> {
    this.calls.push(brief);
    const script = this.byTrio.get(brief.trio_id);
    if (!script) {
      throw new Error(
        `TrioScriptedExecutor: no script for trio_id=${brief.trio_id}`,
      );
    }
    const queue = script[brief.kind] ?? [];
    const idx = this.calls
      .filter((c) => c.trio_id === brief.trio_id && c.kind === brief.kind)
      .length - 1;
    const ret = queue[idx];
    if (!ret) {
      throw new Error(
        `TrioScriptedExecutor: trio ${brief.trio_id} has no scripted return for ${brief.kind} call #${idx + 1}`,
      );
    }
    return ret;
  }
}

// ----------------------------------------------------------------------------
// Canonical round-return fixtures (mirroring trio.test.ts)
// ----------------------------------------------------------------------------

export const planContinue: RoundReturn = {
  status: 'continue',
  summary: 'plan ok',
  next_round_brief: 'impl this thing',
  findings_written: ['f1'],
  commits: [],
};

export const implContinue: RoundReturn = {
  status: 'continue',
  summary: 'impl ok',
  next_round_brief: 'check the thing',
  findings_written: ['f2'],
  commits: ['abc1234'],
};

export const qaPassed: RoundReturn = {
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

export const qaFailedEscalate: RoundReturn = {
  ...qaPassed,
  evaluation: {
    verdict: 'failed-escalate',
    criteria: [
      { criterion: 'idempotency check', outcome: 'failed', note: 'duplicate row on retry' },
    ],
    test_commits: ['def5678'],
    fix_commits: [],
  },
};
