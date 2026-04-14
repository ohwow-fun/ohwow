import { describe, it, expect } from 'vitest';
import { MigrationSchema119RuntimeConfigOverridesExperiment } from '../experiments/migration-schema-119-runtime-config-overrides.js';
import type { ExperimentContext } from '../experiment-types.js';

function fakeDb(rows: Array<{ name: string }>) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  };
  return { from: () => chain };
}

function makeCtx(rows: Array<{ name: string }>): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: fakeDb(rows) as any,
    workspaceId: 'ws-test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async () => [],
  };
}

const EXPECTED = ['runtime_config_overrides'];

describe('MigrationSchema119RuntimeConfigOverridesExperiment (auto-generated)', () => {
  const exp = new MigrationSchema119RuntimeConfigOverridesExperiment();

  it('returns pass when every expected table is present', async () => {
    const rows = EXPECTED.map((name) => ({ name }));
    const result = await exp.probe(makeCtx(rows));
    expect(exp.judge(result, [])).toBe('pass');
    const ev = result.evidence as { missing_tables: string[] };
    expect(ev.missing_tables).toEqual([]);
  });

  it('returns fail when expected tables are missing', async () => {
    const result = await exp.probe(makeCtx([]));
    expect(exp.judge(result, [])).toBe('fail');
    const ev = result.evidence as { missing_tables: string[] };
    expect(ev.missing_tables).toEqual(EXPECTED);
  });

  it('extras in the live schema do not change the verdict', async () => {
    const rows = [
      ...EXPECTED.map((name) => ({ name })),
      { name: 'unrelated_other_table' },
    ];
    const result = await exp.probe(makeCtx(rows));
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('evidence carries migration_file and the expected list', async () => {
    const rows = [{ name: 'runtime_config_overrides' }];
    const result = await exp.probe(makeCtx(rows));
    const ev = result.evidence as { migration_file: string; expected_tables: string[] };
    expect(ev.migration_file).toBe('119-runtime-config-overrides.sql');
    expect(ev.expected_tables).toEqual(EXPECTED);
  });
});
