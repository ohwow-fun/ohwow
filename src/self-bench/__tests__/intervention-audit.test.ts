import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  InterventionAuditExperiment,
  STRATEGY_PERFORMATIVE_KEY,
} from '../experiments/intervention-audit.js';
import { _resetRuntimeConfigCacheForTests } from '../runtime-config.js';
import type { ExperimentContext } from '../experiment-types.js';

/**
 * DB stub supporting the query shapes the probe + intervene use:
 *   .from('experiment_validations').select(...).eq(...).gte(...).limit(n)  — await → {data, error}
 *   .from('runtime_config_overrides').delete().eq('key', k)
 *   .from('runtime_config_overrides').insert(row)
 */
function buildDb(validations: Array<Record<string, unknown>>) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    experiment_validations: validations,
    runtime_config_overrides: [],
  };

  function makeBuilder(table: string) {
    const filters: Array<{ col: string; op: 'eq' | 'gte'; val: unknown }> = [];
    let limitN: number | null = null;

    const apply = () => {
      const rows = tables[table].filter((row) =>
        filters.every((f) => {
          if (f.op === 'eq') return row[f.col] === f.val;
          if (f.op === 'gte') return String(row[f.col] ?? '') >= String(f.val);
          return true;
        }),
      );
      return limitN !== null ? rows.slice(0, limitN) : rows;
    };

    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => {
      filters.push({ col, op: 'eq', val });
      return builder;
    };
    builder.gte = (col: string, val: unknown) => {
      filters.push({ col, op: 'gte', val });
      return builder;
    };
    builder.limit = (n: number) => {
      limitN = n;
      return builder;
    };
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: apply(), error: null });
    builder.insert = (row: Record<string, unknown>) => {
      tables[table].push({ ...row });
      return Promise.resolve({ data: null, error: null });
    };
    builder.delete = () => {
      const delBuilder: Record<string, unknown> = {};
      delBuilder.eq = (col: string, val: unknown) => {
        tables[table] = tables[table].filter((row) => row[col] !== val);
        return Promise.resolve({ data: null, error: null });
      };
      return delBuilder;
    };
    return builder;
  }

  return {
    db: { from: vi.fn().mockImplementation((table: string) => makeBuilder(table)) },
    tables,
  };
}

function makeCtx(env: ReturnType<typeof buildDb>): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: env.db as any,
    workspaceId: 'ws-1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async () => [],
  };
}

function validation(
  experimentId: string,
  outcome: 'held' | 'failed',
): Record<string, unknown> {
  return {
    experiment_id: experimentId,
    outcome,
    status: 'completed',
    completed_at: new Date(Date.now() - 60 * 1000).toISOString(),
  };
}

describe('InterventionAuditExperiment', () => {
  beforeEach(() => {
    _resetRuntimeConfigCacheForTests();
  });

  const exp = new InterventionAuditExperiment();

  it('empty validations table → pass verdict, nothing performative', async () => {
    const env = buildDb([]);
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      total_completed: number;
      performative: string[];
      performative_count: number;
    };
    expect(ev.total_completed).toBe(0);
    expect(ev.performative).toEqual([]);
    expect(ev.performative_count).toBe(0);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('mixed outcomes below MIN_SAMPLE → no performative flag even with 0% hold', async () => {
    // 4 failures total for probe-x — below MIN_SAMPLE=5 so not flagged.
    const env = buildDb([
      validation('probe-x', 'failed'),
      validation('probe-x', 'failed'),
      validation('probe-x', 'failed'),
      validation('probe-x', 'failed'),
      validation('probe-y', 'held'),
      validation('probe-y', 'held'),
    ]);
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      performative: string[];
      performative_count: number;
    };
    expect(ev.performative).toEqual([]);
    expect(ev.performative_count).toBe(0);
  });

  it('below HOLD_RATE_FLOOR over MIN_SAMPLE → experiment flagged', async () => {
    // probe-x: 6 completed, 0 held = 0% → flagged
    // probe-y: 5 completed, 4 held = 80% → not flagged
    const rows = [
      ...Array.from({ length: 6 }, () => validation('probe-x', 'failed')),
      ...Array.from({ length: 4 }, () => validation('probe-y', 'held')),
      validation('probe-y', 'failed'),
    ];
    const env = buildDb(rows);
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      performative: string[];
      performative_count: number;
    };
    expect(ev.performative).toEqual(['probe-x']);
    expect(ev.performative_count).toBe(1);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('intervene() writes strategy.performative_experiments to runtime_config_overrides', async () => {
    const rows = Array.from({ length: 6 }, () => validation('probe-x', 'failed'));
    const env = buildDb(rows);
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    const verdict = exp.judge(result, []);
    const applied = await exp.intervene(verdict, result, ctx);
    expect(applied).not.toBeNull();
    expect(applied?.details.performative).toEqual(['probe-x']);

    const overrides = env.tables.runtime_config_overrides;
    const row = overrides.find((r) => r.key === STRATEGY_PERFORMATIVE_KEY);
    expect(row).toBeDefined();
    expect(JSON.parse(row?.value as string)).toEqual(['probe-x']);
    expect(row?.set_by).toBe('intervention-audit');
  });
});
