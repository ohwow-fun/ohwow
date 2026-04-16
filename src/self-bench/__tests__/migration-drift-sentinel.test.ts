import { describe, it, expect } from 'vitest';
import {
  MigrationDriftSentinelExperiment,
  type MigrationDriftEvidence,
} from '../experiments/migration-drift-sentinel.js';
import { MIGRATION_SCHEMA_REGISTRY } from '../registries/migration-schema-registry.js';
import type { ExperimentContext, Finding } from '../experiment-types.js';

function makeCtx(liveTables: string[]): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {
      from: () => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.limit = () =>
          Promise.resolve({
            data: liveTables.map((name) => ({ name })),
            error: null,
          });
        chain.then = (resolve: (v: unknown) => void) =>
          resolve({ data: [], error: null });
        return chain;
      },
    } as any,
    workspaceId: 'ws-test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async (_id: string, _limit?: number) => [] as Finding[],
  };
}

describe('MigrationDriftSentinelExperiment', () => {
  const exp = new MigrationDriftSentinelExperiment();

  it('passes when every registered table is live', async () => {
    // Enumerate every table expected by the registry; feed them all as
    // live so the probe reports all_passing.
    const expected = new Set<string>();
    for (const row of MIGRATION_SCHEMA_REGISTRY) {
      for (const t of row.expectedTables) expected.add(t);
    }
    const ctx = makeCtx([...expected]);
    const result = await exp.probe(ctx);
    const ev = result.evidence as MigrationDriftEvidence;
    expect(ev.registered_count).toBe(MIGRATION_SCHEMA_REGISTRY.length);
    expect(ev.all_passing).toBe(true);
    expect(ev.missing_rows).toEqual([]);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('fails when a registered table is missing, pointing at the specific row', async () => {
    const firstRow = MIGRATION_SCHEMA_REGISTRY[0];
    // Live table list lacks the FIRST expected table of the first row,
    // includes everything else so exactly one row is flagged.
    const expected = new Set<string>();
    for (const row of MIGRATION_SCHEMA_REGISTRY) {
      for (const t of row.expectedTables) expected.add(t);
    }
    expected.delete(firstRow.expectedTables[0]);

    const ctx = makeCtx([...expected]);
    const result = await exp.probe(ctx);
    const ev = result.evidence as MigrationDriftEvidence;
    expect(ev.all_passing).toBe(false);
    expect(ev.missing_rows.length).toBeGreaterThanOrEqual(1);
    const hit = ev.missing_rows.find((r) => r.migration_file === firstRow.migrationFile);
    expect(hit).toBeDefined();
    expect(hit!.missing_tables).toContain(firstRow.expectedTables[0]);
    expect(exp.judge(result, [])).toBe('fail');
  });
});
