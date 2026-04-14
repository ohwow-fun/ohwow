import { describe, it, expect } from 'vitest';
import { MigrationSchema018WorkspaceOnboardingExperiment } from '../experiments/migration-schema-018-workspace-onboarding.js';
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

const EXPECTED = ['agent_workforce_workspaces'];

describe('MigrationSchema018WorkspaceOnboardingExperiment (auto-generated)', () => {
  const exp = new MigrationSchema018WorkspaceOnboardingExperiment();

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
    const rows = [{ name: 'agent_workforce_workspaces' }];
    const result = await exp.probe(makeCtx(rows));
    const ev = result.evidence as { migration_file: string; expected_tables: string[] };
    expect(ev.migration_file).toBe('018-workspace-onboarding.sql');
    expect(ev.expected_tables).toEqual(EXPECTED);
  });
});
