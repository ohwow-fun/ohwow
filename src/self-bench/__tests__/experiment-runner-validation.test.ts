import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExperimentRunner, DEFAULT_VALIDATION_DELAY_MS } from '../experiment-runner.js';
import type {
  Experiment,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  ValidationResult,
  Verdict,
} from '../experiment-types.js';

/**
 * In-memory stub that supports both self_findings and
 * experiment_validations tables. Supports the chainable calls the
 * runner + stores use: insert, select, eq, lte, order, update, limit.
 */
function buildDb() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    self_findings: [],
    experiment_validations: [],
  };

  function makeBuilder(table: string) {
    const filters: Array<{ col: string; op: 'eq' | 'lte'; val: unknown }> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;

    const apply = () => {
      let out = tables[table].filter((r) =>
        filters.every((f) => {
          if (f.op === 'eq') return r[f.col] === f.val;
          if (f.op === 'lte') return String(r[f.col] ?? '') <= String(f.val);
          return true;
        }),
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
    builder.eq = (col: string, val: unknown) => { filters.push({ col, op: 'eq', val }); return builder; };
    builder.lte = (col: string, val: unknown) => { filters.push({ col, op: 'lte', val }); return builder; };
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
      tables[table].push({ ...row });
      return Promise.resolve({ data: null, error: null });
    };
    builder.update = (patch: Record<string, unknown>) => ({
      eq: (col: string, val: unknown) => {
        for (const row of tables[table]) {
          if (row[col] === val) Object.assign(row, patch);
        }
        return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) };
      },
    });
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: apply(), error: null });
    return builder;
  }

  return {
    db: { from: vi.fn().mockImplementation((table: string) => makeBuilder(table)) },
    tables,
  };
}

function findingRows(rows: Array<Record<string, unknown>>) {
  return rows.filter((r) => r.id !== undefined && r.experiment_id !== undefined);
}

function makeExperiment(opts: {
  id: string;
  validationDelayMs?: number;
  probe: (ctx: ExperimentContext) => Promise<ProbeResult>;
  judge: (result: ProbeResult, history: Finding[]) => Verdict;
  intervene?: (
    verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ) => Promise<InterventionApplied | null>;
  validate?: (
    baseline: Record<string, unknown>,
    ctx: ExperimentContext,
  ) => Promise<ValidationResult>;
  burnDownKeys?: string[];
}): Experiment {
  return {
    id: opts.id,
    name: 'stub',
    category: 'other',
    hypothesis: 'stub hypothesis',
    cadence: { everyMs: 60_000, runOnBoot: true, validationDelayMs: opts.validationDelayMs },
    probe: opts.probe,
    judge: opts.judge,
    intervene: opts.intervene,
    validate: opts.validate,
    burnDownKeys: opts.burnDownKeys,
  };
}

describe('ExperimentRunner — validation scheduling', () => {
  let env: ReturnType<typeof buildDb>;
  let currentTime: number;

  beforeEach(() => {
    env = buildDb();
    currentTime = 1_000_000;
  });

  function buildRunner() {
    return new ExperimentRunner(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env.db as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'ws-1',
      'default',
      { tickIntervalMs: 60_000, now: () => currentTime },
    );
  }

  it('enqueues a validation when intervene returns non-null AND experiment has validate()', async () => {
    const runner = buildRunner();
    const exp = makeExperiment({
      id: 'actor',
      probe: async () => ({ summary: 'probed', evidence: { x: 1 } }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did a thing', details: { undo_key: 'abc' } }),
      validate: async () => ({ outcome: 'held', summary: 'ok', evidence: {} }),
    });
    runner.register(exp);
    await runner.tick();

    expect(env.tables.experiment_validations).toHaveLength(1);
    const v = env.tables.experiment_validations[0];
    expect(v.experiment_id).toBe('actor');
    expect(v.status).toBe('pending');
    const baseline = JSON.parse(v.baseline as string);
    expect(baseline).toMatchObject({ undo_key: 'abc', __autoFollowupPreVerdict: 'warning' });
    expect(baseline.__autoFollowupPreEvidence).toBeDefined();
    // validate_at = now + default delay (15 min)
    const expected = new Date(currentTime + DEFAULT_VALIDATION_DELAY_MS).toISOString();
    expect(v.validate_at).toBe(expected);
  });

  it('uses the experiment cadence.validationDelayMs override when set', async () => {
    const runner = buildRunner();
    const exp = makeExperiment({
      id: 'fast-validate',
      validationDelayMs: 5 * 60 * 1000,
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did it', details: {} }),
      validate: async () => ({ outcome: 'held', summary: 'ok', evidence: {} }),
    });
    runner.register(exp);
    await runner.tick();

    const v = env.tables.experiment_validations[0];
    const expected = new Date(currentTime + 5 * 60 * 1000).toISOString();
    expect(v.validate_at).toBe(expected);
  });

  it('does NOT enqueue a validation when intervene returns null', async () => {
    const runner = buildRunner();
    const exp = makeExperiment({
      id: 'no-op',
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => null,
      validate: async () => ({ outcome: 'held', summary: 'ok', evidence: {} }),
    });
    runner.register(exp);
    await runner.tick();
    expect(env.tables.experiment_validations).toHaveLength(0);
  });

  it('enqueues an auto-followup validation when experiment has no validate method', async () => {
    // New contract: every intervention enqueues a validation, even
    // when the experiment doesn't implement validate() itself. The
    // runner falls back to autoFollowupValidate (probe + verdict
    // comparison) so fire-and-forget interventions still get an
    // accountability row.
    const runner = buildRunner();
    const exp = makeExperiment({
      id: 'unvalidated',
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did it', details: { undo: 1 } }),
      // no validate
    });
    runner.register(exp);
    await runner.tick();
    expect(env.tables.experiment_validations).toHaveLength(1);
    const v = env.tables.experiment_validations[0];
    const baseline = JSON.parse(v.baseline as string);
    expect(baseline).toMatchObject({ undo: 1, __autoFollowupPreVerdict: 'warning' });
    expect(baseline.__autoFollowupPreEvidence).toBeDefined();
  });

  it('DOES enqueue a validation on pass verdict if intervene returns non-null (meta-experiments)', async () => {
    // Phase 4 semantic change: intervene is called on any non-error
    // verdict, so meta-experiments that return a non-null intervention
    // on pass DO get their validation scheduled. Experiments that
    // don't want validation on pass just return null from intervene.
    const runner = buildRunner();
    const exp = makeExperiment({
      id: 'meta',
      probe: async () => ({ summary: 'routine maintenance', evidence: {} }),
      judge: () => 'pass',
      intervene: async () => ({ description: 'adjusted things', details: {} }),
      validate: async () => ({ outcome: 'held', summary: 'ok', evidence: {} }),
    });
    runner.register(exp);
    await runner.tick();
    expect(env.tables.experiment_validations).toHaveLength(1);
  });
});

describe('ExperimentRunner — validation queue processing', () => {
  let env: ReturnType<typeof buildDb>;
  let currentTime: number;

  beforeEach(() => {
    env = buildDb();
    currentTime = 1_000_000;
  });

  function buildRunner() {
    return new ExperimentRunner(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env.db as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'ws-1',
      'default',
      { tickIntervalMs: 60_000, now: () => currentTime },
    );
  }

  it('calls validate() when a pending validation becomes due', async () => {
    const runner = buildRunner();
    const validateSpy = vi.fn().mockResolvedValue({
      outcome: 'held',
      summary: 'intervention still holding',
      evidence: { current_state: 'clean' },
    });
    const exp = makeExperiment({
      id: 'actor',
      validationDelayMs: 60_000,
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did it', details: { baseline_key: 'v1' } }),
      validate: validateSpy,
    });
    runner.register(exp);

    // First tick: experiment runs, intervene fires, validation
    // enqueued with validate_at = now + 60s.
    await runner.tick();
    expect(env.tables.experiment_validations).toHaveLength(1);
    expect(env.tables.experiment_validations[0].status).toBe('pending');
    expect(validateSpy).not.toHaveBeenCalled();

    // Advance time past the validation delay and tick again.
    currentTime += 120_000;
    await runner.tick();

    expect(validateSpy).toHaveBeenCalledTimes(1);
    // The baseline passed to validate() is the intervention.details.
    expect(validateSpy).toHaveBeenCalledWith({ baseline_key: 'v1' }, expect.any(Object));

    // Validation row should now be completed with outcome=held.
    const v = env.tables.experiment_validations[0];
    expect(v.status).toBe('completed');
    expect(v.outcome).toBe('held');
    expect(v.outcome_finding_id).toBeTruthy();
  });

  it('writes a self_findings row with category=validation when validate succeeds', async () => {
    const runner = buildRunner();
    const exp = makeExperiment({
      id: 'actor',
      validationDelayMs: 60_000,
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did', details: { k: 'v' } }),
      validate: async () => ({ outcome: 'held', summary: 'cleanup held', evidence: { drift: 0 } }),
    });
    runner.register(exp);
    await runner.tick();

    currentTime += 120_000;
    await runner.tick();

    const findings = findingRows(env.tables.self_findings);
    const validationFinding = findings.find((f) => f.category === 'validation');
    expect(validationFinding).toBeDefined();
    expect(validationFinding!.verdict).toBe('pass');
    expect(validationFinding!.experiment_id).toBe('actor');
    expect(String(validationFinding!.subject)).toContain('intervention:');
    const evidence = JSON.parse(validationFinding!.evidence as string);
    expect(evidence.is_validation).toBe(true);
    expect(evidence.outcome).toBe('held');
    expect(evidence.baseline).toEqual({ k: 'v' });
    expect(evidence.drift).toBe(0);
  });

  it('maps outcome=failed to verdict=fail in the finding row', async () => {
    const runner = buildRunner();
    const exp = makeExperiment({
      id: 'actor',
      validationDelayMs: 60_000,
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did', details: {} }),
      validate: async () => ({ outcome: 'failed', summary: 'intervention rebounded', evidence: {} }),
    });
    runner.register(exp);
    await runner.tick();
    currentTime += 120_000;
    await runner.tick();

    const findings = findingRows(env.tables.self_findings);
    const validation = findings.find((f) => f.category === 'validation');
    expect(validation!.verdict).toBe('fail');
  });

  it('maps outcome=inconclusive to verdict=warning', async () => {
    const runner = buildRunner();
    const exp = makeExperiment({
      id: 'actor',
      validationDelayMs: 60_000,
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did', details: {} }),
      validate: async () => ({ outcome: 'inconclusive', summary: 'could not tell', evidence: {} }),
    });
    runner.register(exp);
    await runner.tick();
    currentTime += 120_000;
    await runner.tick();

    const findings = findingRows(env.tables.self_findings);
    const validation = findings.find((f) => f.category === 'validation');
    expect(validation!.verdict).toBe('warning');
  });

  it('skips validations for unregistered experiments', async () => {
    const runner = buildRunner();
    const exp = makeExperiment({
      id: 'ghost',
      validationDelayMs: 60_000,
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did', details: {} }),
      validate: async () => ({ outcome: 'held', summary: 'ok', evidence: {} }),
    });
    runner.register(exp);
    await runner.tick();

    // Unregister before validation is due.
    runner.unregister('ghost');
    currentTime += 120_000;
    await runner.tick();

    const v = env.tables.experiment_validations[0];
    expect(v.status).toBe('skipped');
    expect(String(v.error_message)).toContain('not registered');
  });

  it('marks validation as error when validate() throws, but continues running', async () => {
    const runner = buildRunner();
    const boomValidate = vi.fn().mockRejectedValue(new Error('boom'));
    const okValidate = vi.fn().mockResolvedValue({ outcome: 'held', summary: 'ok', evidence: {} });
    runner.register(makeExperiment({
      id: 'broken',
      validationDelayMs: 60_000,
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did', details: {} }),
      validate: boomValidate,
    }));
    runner.register(makeExperiment({
      id: 'fine',
      validationDelayMs: 60_000,
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did', details: {} }),
      validate: okValidate,
    }));

    await runner.tick();
    expect(env.tables.experiment_validations).toHaveLength(2);

    currentTime += 120_000;
    await runner.tick();

    expect(boomValidate).toHaveBeenCalled();
    expect(okValidate).toHaveBeenCalled();
    const broken = env.tables.experiment_validations.find((v) => v.experiment_id === 'broken');
    const fine = env.tables.experiment_validations.find((v) => v.experiment_id === 'fine');
    expect(broken!.status).toBe('error');
    expect(String(broken!.error_message)).toContain('boom');
    expect(fine!.status).toBe('completed');
    expect(fine!.outcome).toBe('held');

    // An error finding should also land in self_findings for visibility.
    const findings = findingRows(env.tables.self_findings);
    const errorFinding = findings.find(
      (f) => f.experiment_id === 'broken' && f.category === 'validation' && f.verdict === 'error',
    );
    expect(errorFinding).toBeDefined();
  });

  it('does NOT process validations whose validate_at is in the future', async () => {
    const runner = buildRunner();
    const validateSpy = vi.fn().mockResolvedValue({ outcome: 'held', summary: 'ok', evidence: {} });
    const exp = makeExperiment({
      id: 'delayed',
      validationDelayMs: 60 * 60 * 1000, // 1 hour
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did', details: {} }),
      validate: validateSpy,
    });
    runner.register(exp);
    await runner.tick();

    currentTime += 30 * 60 * 1000; // only 30 min passed
    await runner.tick();
    expect(validateSpy).not.toHaveBeenCalled();

    currentTime += 35 * 60 * 1000; // now past 1h
    await runner.tick();
    expect(validateSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ExperimentRunner — autoFollowupValidate outcomes', () => {
  let env: ReturnType<typeof buildDb>;
  let currentTime: number;

  beforeEach(() => {
    env = buildDb();
    currentTime = 1_000_000;
  });

  function buildRunner() {
    return new ExperimentRunner(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env.db as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      'ws-1',
      'default',
      { tickIntervalMs: 60_000, now: () => currentTime },
    );
  }

  async function runAutoFollowupWith(opts: {
    probeResults: ProbeResult[];
    verdicts: Verdict[];
    burnDownKeys?: string[];
  }): Promise<Record<string, unknown>> {
    const runner = buildRunner();
    let probeCall = 0;
    let judgeCall = 0;
    const pick = <T>(arr: T[], i: number): T => arr[Math.min(i, arr.length - 1)]!;
    const exp = makeExperiment({
      id: 'auto',
      validationDelayMs: 60_000,
      probe: async () => pick(opts.probeResults, probeCall++),
      judge: () => pick(opts.verdicts, judgeCall++),
      intervene: async () => ({ description: 'did it', details: {} }),
      burnDownKeys: opts.burnDownKeys,
      // no validate → falls back to autoFollowupValidate
    });
    runner.register(exp);
    await runner.tick(); // probe + intervene; enqueue validation
    currentTime += 120_000;
    await runner.tick(); // process validation → autoFollowupValidate runs
    const v = env.tables.experiment_validations[0];
    return v;
  }

  it('pre=warning, post=warning, no scalars on either side → inconclusive', async () => {
    const v = await runAutoFollowupWith({
      probeResults: [
        { summary: 'p1', evidence: { note: 'no scalars' } },
        { summary: 'p2', evidence: { note: 'still no scalars' } },
      ],
      verdicts: ['warning', 'warning'],
    });
    expect(v.status).toBe('completed');
    expect(v.outcome).toBe('inconclusive');
  });

  it('pre=warning, post=warning, scalars present but flat → failed', async () => {
    const v = await runAutoFollowupWith({
      probeResults: [
        { summary: 'p1', evidence: { backlog_count: 5 } },
        { summary: 'p2', evidence: { backlog_count: 5 } },
      ],
      verdicts: ['warning', 'warning'],
    });
    expect(v.outcome).toBe('failed');
  });

  it('pre=warning, post=warning, scalars decreased → held', async () => {
    const v = await runAutoFollowupWith({
      probeResults: [
        { summary: 'p1', evidence: { backlog_count: 5 } },
        { summary: 'p2', evidence: { backlog_count: 3 } },
      ],
      verdicts: ['warning', 'warning'],
    });
    expect(v.outcome).toBe('held');
  });

  it('pre=warning, post=fail (regression) → failed', async () => {
    const v = await runAutoFollowupWith({
      probeResults: [
        { summary: 'p1', evidence: {} },
        { summary: 'p2', evidence: {} },
      ],
      verdicts: ['warning', 'fail'],
    });
    expect(v.outcome).toBe('failed');
  });

  it('burnDownKeys=[] suppresses suffix detection → flat verdict resolves inconclusive even when _count keys are present', async () => {
    const v = await runAutoFollowupWith({
      probeResults: [
        { summary: 'p1', evidence: { concerning_count: 3 } },
        { summary: 'p2', evidence: { concerning_count: 3 } },
      ],
      verdicts: ['warning', 'warning'],
      burnDownKeys: [],
    });
    expect(v.outcome).toBe('inconclusive');
  });

  it('burnDownKeys=["claimed_pool"] honors explicit list, ignoring other suffix-matching keys', async () => {
    const v = await runAutoFollowupWith({
      probeResults: [
        { summary: 'p1', evidence: { claimed_pool: 5, noise_count: 99 } },
        { summary: 'p2', evidence: { claimed_pool: 4, noise_count: 12 } },
      ],
      verdicts: ['warning', 'warning'],
      burnDownKeys: ['claimed_pool'],
    });
    expect(v.outcome).toBe('held');
  });
});
