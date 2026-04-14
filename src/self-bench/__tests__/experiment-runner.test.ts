import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExperimentRunner } from '../experiment-runner.js';
import type {
  Experiment,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

/**
 * Reuses the same builder pattern as findings-store.test.ts — just
 * enough to satisfy writeFinding + readRecentFindings chained calls.
 */
function buildDb() {
  const rows: Array<Record<string, unknown>> = [];

  function makeBuilder() {
    const filters: Array<{ col: string; val: unknown }> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;

    const apply = () => {
      let out = rows.filter((r) =>
        filters.every((f) => r[f.col] === f.val),
      );
      if (orderCol) {
        const key = orderCol;
        out = [...out].sort((a, b) => {
          const av = String(a[key] ?? '');
          const bv = String(b[key] ?? '');
          return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };

    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => { filters.push({ col, val }); return builder; };
    builder.order = (col: string, opts?: { ascending?: boolean }) => {
      orderCol = col;
      orderAsc = opts?.ascending !== false;
      return builder;
    };
    builder.limit = (n: number) => {
      limitN = n;
      return Promise.resolve({ data: apply(), error: null });
    };
    builder.insert = (row: Record<string, unknown>) => {
      rows.push({ ...row });
      return Promise.resolve({ data: null, error: null });
    };
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: apply(), error: null });
    return builder;
  }

  return {
    db: { from: vi.fn().mockImplementation(() => makeBuilder()) },
    rows,
  };
}

function findingRows(rows: Array<Record<string, unknown>>) {
  return rows.filter((r) => r.id !== undefined && r.experiment_id !== undefined);
}

function makeStubExperiment(opts: {
  id: string;
  everyMs: number;
  runOnBoot?: boolean;
  probe: (ctx: ExperimentContext) => Promise<ProbeResult>;
  judge: (result: ProbeResult, history: Finding[]) => Verdict;
  intervene?: (
    verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ) => Promise<InterventionApplied | null>;
}): Experiment & { probeCallCount: number } {
  const state = { probeCallCount: 0 };
  const exp: Experiment & { probeCallCount: number } = {
    id: opts.id,
    name: 'stub',
    category: 'other',
    hypothesis: 'stub hypothesis',
    cadence: { everyMs: opts.everyMs, runOnBoot: opts.runOnBoot },
    async probe(ctx) {
      state.probeCallCount++;
      exp.probeCallCount = state.probeCallCount;
      return opts.probe(ctx);
    },
    judge(result, history) {
      return opts.judge(result, history);
    },
    get probeCallCount() { return state.probeCallCount; },
    set probeCallCount(n: number) { state.probeCallCount = n; },
  };
  if (opts.intervene) {
    exp.intervene = opts.intervene;
  }
  return exp;
}

describe('ExperimentRunner', () => {
  let env: ReturnType<typeof buildDb>;
  let currentTime: number;

  beforeEach(() => {
    env = buildDb();
    currentTime = 1_000_000;
  });

  function buildRunner() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new ExperimentRunner(env.db as any, {} as any, 'ws-1', 'default', {
      tickIntervalMs: 60_000,
      now: () => currentTime,
    });
  }

  it('runs an experiment with runOnBoot: true immediately on tick', async () => {
    const runner = buildRunner();
    const exp = makeStubExperiment({
      id: 'e1',
      everyMs: 60_000,
      runOnBoot: true,
      probe: async () => ({ subject: 'x', summary: 'probed', evidence: { n: 1 } }),
      judge: () => 'pass',
    });
    runner.register(exp);
    await runner.tick();

    expect(exp.probeCallCount).toBe(1);
    const findings = findingRows(env.rows);
    expect(findings).toHaveLength(1);
    expect(findings[0].experiment_id).toBe('e1');
    expect(findings[0].verdict).toBe('pass');
    expect(findings[0].subject).toBe('x');
    expect(findings[0].summary).toBe('probed');
  });

  it('defers runOnBoot: false experiments until the interval has elapsed', async () => {
    const runner = buildRunner();
    const exp = makeStubExperiment({
      id: 'e2',
      everyMs: 60_000,
      runOnBoot: false,
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'pass',
    });
    runner.register(exp);
    await runner.tick();
    expect(exp.probeCallCount).toBe(0);

    currentTime += 70_000;
    await runner.tick();
    expect(exp.probeCallCount).toBe(1);
  });

  it('re-runs the same experiment across multiple ticks at the cadence', async () => {
    const runner = buildRunner();
    const exp = makeStubExperiment({
      id: 'e3',
      everyMs: 10_000,
      runOnBoot: true,
      probe: async () => ({ summary: 'probe', evidence: {} }),
      judge: () => 'pass',
    });
    runner.register(exp);
    await runner.tick();

    currentTime += 5_000;
    await runner.tick();
    expect(exp.probeCallCount).toBe(1); // not due yet

    currentTime += 10_000;
    await runner.tick();
    expect(exp.probeCallCount).toBe(2);

    currentTime += 10_000;
    await runner.tick();
    expect(exp.probeCallCount).toBe(3);
  });

  it('calls intervene only for non-pass, non-error verdicts', async () => {
    const runner = buildRunner();
    const interveneSpy = vi.fn().mockResolvedValue({ description: 'did a thing', details: {} });
    const exp = makeStubExperiment({
      id: 'e4',
      everyMs: 60_000,
      runOnBoot: true,
      probe: async () => ({ summary: 'probe', evidence: {} }),
      judge: () => 'warning',
      intervene: interveneSpy,
    });
    runner.register(exp);
    await runner.tick();

    expect(interveneSpy).toHaveBeenCalledTimes(1);
    const findings = findingRows(env.rows);
    const intervention = JSON.parse(findings[0].intervention_applied as string);
    expect(intervention.description).toBe('did a thing');
  });

  it('DOES call intervene on pass verdicts (experiments early-return null when there is nothing to do)', async () => {
    const runner = buildRunner();
    const interveneSpy = vi.fn().mockResolvedValue(null);
    const exp = makeStubExperiment({
      id: 'e5',
      everyMs: 60_000,
      runOnBoot: true,
      probe: async () => ({ summary: 'all good', evidence: {} }),
      judge: () => 'pass',
      intervene: interveneSpy,
    });
    runner.register(exp);
    await runner.tick();
    // Changed in Phase 4: intervene is called on any non-error
    // verdict. Existing experiments early-return null when there's
    // nothing to do; meta-experiments use this hook to apply
    // routine scheduler adjustments even on pass.
    expect(interveneSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT call intervene when probe threw (error verdict)', async () => {
    const runner = buildRunner();
    const interveneSpy = vi.fn();
    const exp = makeStubExperiment({
      id: 'e5b',
      everyMs: 60_000,
      runOnBoot: true,
      probe: async () => { throw new Error('probe blew up'); },
      judge: () => 'pass',
      intervene: interveneSpy,
    });
    runner.register(exp);
    await runner.tick();
    expect(interveneSpy).not.toHaveBeenCalled();
  });

  it('writes a verdict=error finding when probe throws', async () => {
    const runner = buildRunner();
    const exp = makeStubExperiment({
      id: 'e6',
      everyMs: 60_000,
      runOnBoot: true,
      probe: async () => { throw new Error('probe blew up'); },
      judge: () => 'pass',
    });
    runner.register(exp);
    await runner.tick();

    const findings = findingRows(env.rows);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe('error');
    expect(findings[0].summary).toBe('probe blew up');
  });

  it('writes a verdict=error finding when judge throws', async () => {
    const runner = buildRunner();
    const exp = makeStubExperiment({
      id: 'e7',
      everyMs: 60_000,
      runOnBoot: true,
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => { throw new Error('judge blew up'); },
    });
    runner.register(exp);
    await runner.tick();

    const findings = findingRows(env.rows);
    expect(findings[0].verdict).toBe('error');
  });

  it('continues running other experiments after one throws', async () => {
    const runner = buildRunner();
    const broken = makeStubExperiment({
      id: 'broken',
      everyMs: 60_000,
      runOnBoot: true,
      probe: async () => { throw new Error('nope'); },
      judge: () => 'pass',
    });
    const healthy = makeStubExperiment({
      id: 'healthy',
      everyMs: 60_000,
      runOnBoot: true,
      probe: async () => ({ summary: 'still good', evidence: {} }),
      judge: () => 'pass',
    });
    runner.register(broken);
    runner.register(healthy);
    await runner.tick();

    expect(broken.probeCallCount).toBe(1);
    expect(healthy.probeCallCount).toBe(1);
    const findings = findingRows(env.rows);
    expect(findings).toHaveLength(2);
    expect(findings.find((f) => f.experiment_id === 'broken')?.verdict).toBe('error');
    expect(findings.find((f) => f.experiment_id === 'healthy')?.verdict).toBe('pass');
  });

  it('same experiment does not re-enter while a prior tick is in flight', async () => {
    // Per-experiment inFlight guard: overlapping ticks (from setInterval
    // firing while the prior tick is still awaiting) must not re-claim
    // an experiment that is still mid-run. The slow experiment's
    // probe hangs; a second tick is fired before the probe resolves;
    // the second tick must see 'slow' in inFlight and skip it.
    const runner = buildRunner();
    let resolveProbe: () => void = () => {};
    const exp = makeStubExperiment({
      id: 'slow',
      everyMs: 1,
      runOnBoot: true,
      probe: () => new Promise((resolve) => {
        resolveProbe = () => resolve({ summary: 's', evidence: {} });
      }),
      judge: () => 'pass',
    });
    runner.register(exp);

    const firstTick = runner.tick();
    const secondTick = runner.tick();
    // Second tick finds 'slow' in inFlight and skips it; only the
    // first tick's probe invocation has happened.
    await secondTick;
    expect(exp.probeCallCount).toBe(1);

    resolveProbe();
    await firstTick;
  });

  it('experiments fire in parallel within a single tick', async () => {
    // Under the parallel-fire model, a slow experiment (e.g. the Phase
    // 7-D author running typecheck + vitest for tens of seconds) must
    // not block faster experiments from completing on the same tick.
    // Assertion: the fast experiment's completion timestamp is
    // recorded BEFORE the slow experiment's, proving the two
    // Promises are running concurrently rather than sequentially.
    const runner = buildRunner();
    const completionOrder: string[] = [];

    let resolveSlow: () => void = () => {};
    const slow = makeStubExperiment({
      id: 'slow',
      everyMs: 60_000,
      runOnBoot: true,
      probe: () => new Promise((resolve) => {
        resolveSlow = () => {
          completionOrder.push('slow');
          resolve({ summary: 's', evidence: {} });
        };
      }),
      judge: () => 'pass',
    });

    const fast = makeStubExperiment({
      id: 'fast',
      everyMs: 60_000,
      runOnBoot: true,
      probe: async () => {
        completionOrder.push('fast');
        return { summary: 'f', evidence: {} };
      },
      judge: () => 'pass',
    });

    runner.register(slow);
    runner.register(fast);

    const tickPromise = runner.tick();
    // Let the microtask queue drain so 'fast' can complete while
    // 'slow' is still awaiting the external resolver.
    await new Promise((r) => setImmediate(r));
    expect(completionOrder).toEqual(['fast']);

    // Now let the slow one finish and the tick resolve.
    resolveSlow();
    await tickPromise;
    expect(completionOrder).toEqual(['fast', 'slow']);
    expect(fast.probeCallCount).toBe(1);
    expect(slow.probeCallCount).toBe(1);
  });

  it('registeredIds returns every registered experiment', () => {
    const runner = buildRunner();
    runner.register(makeStubExperiment({
      id: 'a', everyMs: 60_000, runOnBoot: true,
      probe: async () => ({ summary: '', evidence: {} }),
      judge: () => 'pass',
    }));
    runner.register(makeStubExperiment({
      id: 'b', everyMs: 60_000, runOnBoot: true,
      probe: async () => ({ summary: '', evidence: {} }),
      judge: () => 'pass',
    }));
    expect(runner.registeredIds().sort()).toEqual(['a', 'b']);
  });

  it('unregister removes an experiment from the schedule', async () => {
    const runner = buildRunner();
    const exp = makeStubExperiment({
      id: 'doomed', everyMs: 60_000, runOnBoot: true,
      probe: async () => ({ summary: '', evidence: {} }),
      judge: () => 'pass',
    });
    runner.register(exp);
    runner.unregister('doomed');
    await runner.tick();
    expect(exp.probeCallCount).toBe(0);
  });
});
