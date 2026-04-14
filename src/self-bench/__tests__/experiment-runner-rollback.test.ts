import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExperimentRunner } from '../experiment-runner.js';
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
 * In-memory stub supporting self_findings + experiment_validations
 * tables with enough surface for the runner's rollback path:
 * insert/select/eq/lte/order/update/limit + the markValidationRolledBack
 * write path.
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
  rollback?: (
    baseline: Record<string, unknown>,
    ctx: ExperimentContext,
  ) => Promise<InterventionApplied | null>;
}): Experiment {
  return {
    id: opts.id,
    name: 'rollback-test',
    category: 'other',
    hypothesis: 'stub',
    cadence: { everyMs: 60_000, runOnBoot: true, validationDelayMs: 60_000 },
    probe: opts.probe,
    judge: opts.judge,
    intervene: opts.intervene,
    validate: opts.validate,
    rollback: opts.rollback,
  };
}

describe('ExperimentRunner — rollback', () => {
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
      { tickIntervalMs: 60_000, now: () => currentTime },
    );
  }

  async function runInterventionCycle(
    runner: ExperimentRunner,
    exp: Experiment,
  ): Promise<void> {
    runner.register(exp);
    await runner.tick();              // probe → intervene → finding → enqueue validation
    currentTime += 120_000;            // advance past validation delay
    await runner.tick();              // process validation queue
  }

  it('calls rollback() when validate returns outcome=failed', async () => {
    const runner = buildRunner();
    const rollbackSpy = vi.fn().mockResolvedValue({
      description: 'reverted the change',
      details: { undone: 'config_key_x' },
    });
    const exp = makeExperiment({
      id: 'reversible',
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'made a change', details: { key: 'v1' } }),
      validate: async () => ({ outcome: 'failed', summary: 'change rebounded', evidence: {} }),
      rollback: rollbackSpy,
    });

    await runInterventionCycle(runner, exp);

    expect(rollbackSpy).toHaveBeenCalledTimes(1);
    expect(rollbackSpy).toHaveBeenCalledWith({ key: 'v1' }, expect.any(Object));
  });

  it('does NOT call rollback when validate returns outcome=held', async () => {
    const runner = buildRunner();
    const rollbackSpy = vi.fn();
    const exp = makeExperiment({
      id: 'healthy',
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did it', details: {} }),
      validate: async () => ({ outcome: 'held', summary: 'held', evidence: {} }),
      rollback: rollbackSpy,
    });
    await runInterventionCycle(runner, exp);
    expect(rollbackSpy).not.toHaveBeenCalled();
  });

  it('does NOT call rollback when validate returns outcome=inconclusive', async () => {
    const runner = buildRunner();
    const rollbackSpy = vi.fn();
    const exp = makeExperiment({
      id: 'murky',
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did it', details: {} }),
      validate: async () => ({ outcome: 'inconclusive', summary: 'murky', evidence: {} }),
      rollback: rollbackSpy,
    });
    await runInterventionCycle(runner, exp);
    expect(rollbackSpy).not.toHaveBeenCalled();
  });

  it('writes a category=validation finding with verdict=warning and is_rollback=true', async () => {
    const runner = buildRunner();
    const exp = makeExperiment({
      id: 'reversible',
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'made a change', details: {} }),
      validate: async () => ({ outcome: 'failed', summary: 'rebounded', evidence: {} }),
      rollback: async () => ({
        description: 'reverted the change',
        details: { undone: 'x' },
      }),
    });
    await runInterventionCycle(runner, exp);

    const findings = findingRows(env.tables.self_findings);
    const rollbackFinding = findings.find(
      (f) => String(f.subject ?? '').startsWith('rollback:'),
    );
    expect(rollbackFinding).toBeDefined();
    expect(rollbackFinding!.verdict).toBe('warning');
    expect(rollbackFinding!.category).toBe('validation');
    const evidence = JSON.parse(rollbackFinding!.evidence as string);
    expect(evidence.is_rollback).toBe(true);
    expect(evidence.rollback_details).toEqual({ undone: 'x' });
  });

  it('stamps the validation row with rolled_back=1 + rollback_finding_id', async () => {
    const runner = buildRunner();
    const exp = makeExperiment({
      id: 'reversible',
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'made a change', details: {} }),
      validate: async () => ({ outcome: 'failed', summary: 'rebounded', evidence: {} }),
      rollback: async () => ({ description: 'reverted', details: {} }),
    });
    await runInterventionCycle(runner, exp);

    const v = env.tables.experiment_validations[0];
    expect(v.rolled_back).toBe(1);
    expect(v.rollback_finding_id).toBeTruthy();
    expect(typeof v.rolled_back_at).toBe('string');
    // The validation itself still shows outcome=failed (that's why
    // we rolled back); the rollback columns are the self-heal flag.
    expect(v.outcome).toBe('failed');
  });

  it('does NOT call rollback when experiment has no rollback method', async () => {
    const runner = buildRunner();
    const exp = makeExperiment({
      id: 'irreversible',
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did it', details: {} }),
      validate: async () => ({ outcome: 'failed', summary: 'rebounded', evidence: {} }),
      // no rollback
    });
    await runInterventionCycle(runner, exp);
    const v = env.tables.experiment_validations[0];
    expect(v.rolled_back ?? 0).toBe(0);
    expect(v.rollback_finding_id).toBeUndefined();
  });

  it('tolerates rollback returning null (nothing to undo)', async () => {
    const runner = buildRunner();
    const rollbackSpy = vi.fn().mockResolvedValue(null);
    const exp = makeExperiment({
      id: 'no-op-rollback',
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did it', details: {} }),
      validate: async () => ({ outcome: 'failed', summary: 'rebounded', evidence: {} }),
      rollback: rollbackSpy,
    });
    await runInterventionCycle(runner, exp);
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
    // No rollback finding — the rollback ran but had nothing to do.
    const findings = findingRows(env.tables.self_findings);
    const rollbackFinding = findings.find((f) => String(f.subject ?? '').startsWith('rollback:'));
    expect(rollbackFinding).toBeUndefined();
    // Validation row should NOT be stamped as rolled back.
    const v = env.tables.experiment_validations[0];
    expect(v.rolled_back ?? 0).toBe(0);
  });

  it('writes an error finding when rollback() throws, does not block other work', async () => {
    const runner = buildRunner();
    const exp = makeExperiment({
      id: 'broken-rollback',
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({ description: 'did it', details: {} }),
      validate: async () => ({ outcome: 'failed', summary: 'rebounded', evidence: {} }),
      rollback: async () => { throw new Error('rollback blew up'); },
    });
    await runInterventionCycle(runner, exp);

    const findings = findingRows(env.tables.self_findings);
    const errorFinding = findings.find(
      (f) => String(f.subject ?? '').startsWith('rollback:') && f.verdict === 'error',
    );
    expect(errorFinding).toBeDefined();
    expect(String(errorFinding!.summary)).toContain('rollback blew up');
  });

  it('rollback receives the same baseline that validate received', async () => {
    const runner = buildRunner();
    let baselineSeenByValidate: Record<string, unknown> | null = null;
    let baselineSeenByRollback: Record<string, unknown> | null = null;
    const exp = makeExperiment({
      id: 'baseline-check',
      probe: async () => ({ summary: 'probed', evidence: {} }),
      judge: () => 'warning',
      intervene: async () => ({
        description: 'did it',
        details: { original_key: 'original_value', nested: { a: 1 } },
      }),
      validate: async (baseline) => {
        baselineSeenByValidate = baseline;
        return { outcome: 'failed', summary: 'rebounded', evidence: {} };
      },
      rollback: async (baseline) => {
        baselineSeenByRollback = baseline;
        return { description: 'reverted', details: {} };
      },
    });
    await runInterventionCycle(runner, exp);

    expect(baselineSeenByRollback).not.toBeNull();
    expect(baselineSeenByRollback).toEqual(baselineSeenByValidate);
    expect(baselineSeenByRollback).toEqual({
      original_key: 'original_value',
      nested: { a: 1 },
    });
  });
});
