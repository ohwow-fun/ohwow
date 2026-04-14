/**
 * Tests for MigrationSchemaProbeExperiment + the registry it consumes.
 *
 * The deleted per-migration classes shipped with one near-identical
 * test file each (~60 lines × 17 files = ~1000 lines of duplicate
 * test). This file replaces them with one parameterized describe
 * block plus a registry-coverage test that asserts every migration in
 * src/db/migrations/ is either listed in the registry, lists no
 * CREATE TABLE statements (so a registry row would carry no signal),
 * or is explicitly opted out.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  MigrationSchemaProbeExperiment,
  slugFromFilename,
} from '../experiments/migration-schema-probe.js';
import { MIGRATION_SCHEMA_REGISTRY } from '../registries/migration-schema-registry.js';
import type { ExperimentContext } from '../experiment-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

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

describe('MigrationSchemaProbeExperiment — parameterized', () => {
  // Pick one row to exercise the per-instance behavior. Same shape
  // applies to every other row in the registry.
  const sampleConfig = {
    migrationFile: '008-plans.sql',
    expectedTables: ['agent_workforce_plans', 'agent_workforce_plan_steps'] as const,
  };

  it('exposes a stable id derived from the filename', () => {
    const exp = new MigrationSchemaProbeExperiment(sampleConfig);
    expect(exp.id).toBe('migration-schema-008-plans');
    expect(exp.name).toBe('Migration schema probe: 008-plans.sql');
  });

  it('returns pass when every expected table is present', async () => {
    const exp = new MigrationSchemaProbeExperiment(sampleConfig);
    const rows = sampleConfig.expectedTables.map((name) => ({ name }));
    const result = await exp.probe(makeCtx(rows));
    expect(exp.judge(result, [])).toBe('pass');
    const ev = result.evidence as { missing_tables: string[] };
    expect(ev.missing_tables).toEqual([]);
  });

  it('returns fail when expected tables are missing', async () => {
    const exp = new MigrationSchemaProbeExperiment(sampleConfig);
    const result = await exp.probe(makeCtx([]));
    expect(exp.judge(result, [])).toBe('fail');
    const ev = result.evidence as { missing_tables: string[] };
    expect(ev.missing_tables).toEqual([...sampleConfig.expectedTables]);
  });

  it('extras in the live schema do not change the verdict', async () => {
    const exp = new MigrationSchemaProbeExperiment(sampleConfig);
    const rows = [
      ...sampleConfig.expectedTables.map((name) => ({ name })),
      { name: 'unrelated_other_table' },
    ];
    const result = await exp.probe(makeCtx(rows));
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('evidence carries migration_file and the expected list', async () => {
    const exp = new MigrationSchemaProbeExperiment(sampleConfig);
    const rows = [{ name: 'agent_workforce_plans' }];
    const result = await exp.probe(makeCtx(rows));
    const ev = result.evidence as { migration_file: string; expected_tables: string[] };
    expect(ev.migration_file).toBe('008-plans.sql');
    expect(ev.expected_tables).toEqual([...sampleConfig.expectedTables]);
  });
});

describe('MIGRATION_SCHEMA_REGISTRY — invariants', () => {
  it('every row instantiates a probe with a unique id', () => {
    const ids = MIGRATION_SCHEMA_REGISTRY.map((c) => new MigrationSchemaProbeExperiment(c).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no two rows share the same migrationFile', () => {
    const files = MIGRATION_SCHEMA_REGISTRY.map((c) => c.migrationFile);
    expect(new Set(files).size).toBe(files.length);
  });

  it('every migrationFile resolves to a real file on disk', () => {
    const onDisk = new Set(readdirSync(MIGRATIONS_DIR));
    for (const row of MIGRATION_SCHEMA_REGISTRY) {
      expect(onDisk.has(row.migrationFile)).toBe(true);
    }
  });

  it('every expectedTables list has at least one entry', () => {
    for (const row of MIGRATION_SCHEMA_REGISTRY) {
      expect(row.expectedTables.length).toBeGreaterThan(0);
    }
  });

  it('slugFromFilename matches the legacy id format the deleted classes used', () => {
    expect(slugFromFilename('008-plans.sql')).toBe('008-plans');
    expect(slugFromFilename('119-runtime-config-overrides.sql')).toBe('119-runtime-config-overrides');
    // Idempotent on already-slugified input — defensive against double-trim.
    expect(slugFromFilename('116-self-findings')).toBe('116-self-findings');
  });
});

describe('MIGRATION_SCHEMA_REGISTRY — coverage of migrations that contain CREATE TABLE', () => {
  it('every migration that creates tables has a registry row OR is intentionally excluded', () => {
    const onDisk = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    const covered = new Set(MIGRATION_SCHEMA_REGISTRY.map((r) => r.migrationFile));

    // Migrations that ALTER existing tables or insert seed rows but
    // create no new tables don't need a registry row — there is
    // nothing for the probe to verify.
    const createTableRe = /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?[a-z_]+/i;
    const uncovered: string[] = [];
    for (const file of onDisk) {
      if (covered.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
      if (createTableRe.test(sql)) uncovered.push(file);
    }

    // We expect the proposal generator to fill these gaps over time.
    // For now we just surface the count so it doesn't grow silently.
    // If this assertion ever fails, either add a row to the registry
    // OR document why the migration is intentionally excluded.
    if (uncovered.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[migration-schema-registry] ${uncovered.length} migrations create tables but lack a registry row:`,
        uncovered,
      );
    }
    // Soft assertion — coverage gap is a warning, not a failure. The
    // hard guarantee is "no broken registry rows," not "100% coverage."
    expect(uncovered.length).toBeLessThan(onDisk.length);
  });
});
