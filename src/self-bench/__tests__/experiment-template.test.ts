import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  fillExperimentTemplate,
  validateBrief,
  type ExperimentBrief,
  type MigrationSchemaProbeParams,
  type ModelLatencyProbeParams,
} from '../experiment-template.js';

/**
 * These tests exercise the template slot-filler both statically
 * (validateBrief + fillExperimentTemplate return shapes) and
 * dynamically (write the generated source to a temp file and run
 * tsc against it to confirm the output actually compiles). The
 * compilation test is the real contract — if a brief can be
 * validated but the generated code doesn't compile, Phase 7 is
 * broken.
 */

const goodBrief: ExperimentBrief = {
  slug: 'qwen-35b-latency',
  name: 'Qwen 3.5 35B latency probe',
  hypothesis: 'qwen3.5-35b-a3b p50 latency stays under 3 seconds on work-shaped tasks.',
  everyMs: 30 * 60 * 1000,
  template: 'model_latency_probe',
  params: {
    model_id: 'qwen/qwen3.5-35b-a3b',
    sample_size: 50,
    warn_latency_ms: 3000,
    fail_latency_ms: 6000,
    min_samples: 10,
  } satisfies ModelLatencyProbeParams,
};

describe('validateBrief', () => {
  it('accepts a well-formed brief', () => {
    expect(validateBrief(goodBrief)).toBeNull();
  });

  it('rejects a non-kebab slug', () => {
    expect(validateBrief({ ...goodBrief, slug: 'Qwen35bLatency' })).toContain('kebab-case');
  });

  it('rejects an empty name', () => {
    expect(validateBrief({ ...goodBrief, name: '' })).toContain('name');
  });

  it('rejects a cadence below 1 minute', () => {
    expect(validateBrief({ ...goodBrief, everyMs: 30_000 })).toContain('everyMs');
  });

  it('rejects a cadence above 24 hours', () => {
    expect(validateBrief({ ...goodBrief, everyMs: 2 * 24 * 60 * 60 * 1000 })).toContain('everyMs');
  });

  it('rejects an unknown template', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(validateBrief({ ...goodBrief, template: 'fake' as any })).toContain('unknown template');
  });

  it('rejects model_id outside 1..200 chars', () => {
    const b: ExperimentBrief = {
      ...goodBrief,
      params: { ...(goodBrief.params as ModelLatencyProbeParams), model_id: '' },
    };
    expect(validateBrief(b)).toContain('model_id');
  });

  it('rejects sample_size out of range', () => {
    const b: ExperimentBrief = {
      ...goodBrief,
      params: { ...(goodBrief.params as ModelLatencyProbeParams), sample_size: 3 },
    };
    expect(validateBrief(b)).toContain('sample_size');
  });

  it('rejects fail_latency_ms <= warn_latency_ms', () => {
    const b: ExperimentBrief = {
      ...goodBrief,
      params: {
        ...(goodBrief.params as ModelLatencyProbeParams),
        warn_latency_ms: 5000,
        fail_latency_ms: 3000,
      },
    };
    expect(validateBrief(b)).toContain('fail_latency_ms');
  });
});

describe('fillExperimentTemplate — static shape', () => {
  it('returns expected paths for both source and test files', () => {
    const out = fillExperimentTemplate(goodBrief);
    expect(out.sourcePath).toBe('src/self-bench/experiments/qwen-35b-latency.ts');
    expect(out.testPath).toBe('src/self-bench/__tests__/qwen-35b-latency.test.ts');
  });

  it('emits a class name derived from the slug', () => {
    const out = fillExperimentTemplate(goodBrief);
    expect(out.sourceContent).toContain('class Qwen35bLatencyExperiment');
    expect(out.testContent).toContain('Qwen35bLatencyExperiment');
  });

  it('embeds the brief parameters into the source body', () => {
    const out = fillExperimentTemplate(goodBrief);
    expect(out.sourceContent).toContain("'qwen/qwen3.5-35b-a3b'");
    expect(out.sourceContent).toContain('3000'); // warn_latency_ms
    expect(out.sourceContent).toContain('6000'); // fail_latency_ms
    expect(out.sourceContent).toContain('50');   // sample_size
  });

  it('includes the AUTO-GENERATED marker comment', () => {
    const out = fillExperimentTemplate(goodBrief);
    expect(out.sourceContent).toContain('AUTO-GENERATED');
  });

  it('escapes single quotes in string slots', () => {
    const brief: ExperimentBrief = {
      ...goodBrief,
      slug: 'quote-test',
      hypothesis: "this one's tricky",
    };
    const out = fillExperimentTemplate(brief);
    // The apostrophe must be properly escaped inside the TS literal
    expect(out.sourceContent).toContain("this one\\'s tricky");
  });

  it('throws on invalid brief', () => {
    expect(() =>
      fillExperimentTemplate({ ...goodBrief, slug: 'BAD' }),
    ).toThrow('invalid brief');
  });
});

const goodMigrationBrief: ExperimentBrief = {
  slug: 'migration-schema-016-dashboard-tables',
  name: 'Migration schema probe: 016-dashboard-tables.sql',
  hypothesis: 'All tables created in 016-dashboard-tables.sql remain present in the live sqlite schema.',
  everyMs: 60 * 60 * 1000,
  template: 'migration_schema_probe',
  params: {
    migration_file: '016-dashboard-tables.sql',
    expected_tables: ['dashboards', 'dashboard_widgets'],
  } satisfies MigrationSchemaProbeParams,
};

describe('validateBrief — migration_schema_probe', () => {
  it('accepts a well-formed migration brief', () => {
    expect(validateBrief(goodMigrationBrief)).toBeNull();
  });

  it('rejects an empty migration_file', () => {
    const b: ExperimentBrief = {
      ...goodMigrationBrief,
      params: { ...(goodMigrationBrief.params as MigrationSchemaProbeParams), migration_file: '' },
    };
    expect(validateBrief(b)).toContain('migration_file');
  });

  it('rejects a migration_file containing a path separator', () => {
    const b: ExperimentBrief = {
      ...goodMigrationBrief,
      params: {
        ...(goodMigrationBrief.params as MigrationSchemaProbeParams),
        migration_file: '../etc/passwd',
      },
    };
    expect(validateBrief(b)).toContain('bare basename');
  });

  it('rejects an empty expected_tables array', () => {
    const b: ExperimentBrief = {
      ...goodMigrationBrief,
      params: { ...(goodMigrationBrief.params as MigrationSchemaProbeParams), expected_tables: [] },
    };
    expect(validateBrief(b)).toContain('expected_tables');
  });

  it('rejects an invalid table identifier in expected_tables', () => {
    const b: ExperimentBrief = {
      ...goodMigrationBrief,
      params: {
        ...(goodMigrationBrief.params as MigrationSchemaProbeParams),
        expected_tables: ['good_table', 'bad-table'],
      },
    };
    expect(validateBrief(b)).toContain('bad-table');
  });
});

describe('fillExperimentTemplate — migration_schema_probe', () => {
  it('returns expected source and test paths', () => {
    const out = fillExperimentTemplate(goodMigrationBrief);
    expect(out.sourcePath).toBe(
      'src/self-bench/experiments/migration-schema-016-dashboard-tables.ts',
    );
    expect(out.testPath).toBe(
      'src/self-bench/__tests__/migration-schema-016-dashboard-tables.test.ts',
    );
  });

  it('embeds the migration file name and expected tables in source', () => {
    const out = fillExperimentTemplate(goodMigrationBrief);
    expect(out.sourceContent).toContain('016-dashboard-tables.sql');
    expect(out.sourceContent).toContain('dashboards');
    expect(out.sourceContent).toContain('dashboard_widgets');
  });

  it('includes AUTO-GENERATED marker', () => {
    const out = fillExperimentTemplate(goodMigrationBrief);
    expect(out.sourceContent).toContain('AUTO-GENERATED');
  });

  it('emits a class derived from the slug', () => {
    const out = fillExperimentTemplate(goodMigrationBrief);
    expect(out.sourceContent).toContain('class MigrationSchema016DashboardTablesExperiment');
    expect(out.testContent).toContain('MigrationSchema016DashboardTablesExperiment');
  });

  it('test content includes pass and fail cases', () => {
    const out = fillExperimentTemplate(goodMigrationBrief);
    expect(out.testContent).toContain("toBe('pass')");
    expect(out.testContent).toContain("toBe('fail')");
  });

  it('throws on invalid brief', () => {
    const bad: ExperimentBrief = {
      ...goodMigrationBrief,
      params: {
        ...(goodMigrationBrief.params as MigrationSchemaProbeParams),
        expected_tables: [],
      },
    };
    expect(() => fillExperimentTemplate(bad)).toThrow('invalid brief');
  });
});

describe('fillExperimentTemplate — compilation smoke test', () => {
  it('model_latency_probe generated source compiles against the real Experiment interface', () => {
    const out = fillExperimentTemplate(goodBrief);

    // Write to a temp file inside the real repo's src/self-bench/
    // directory so it picks up the real tsconfig + type imports.
    // Use a throwaway slug to avoid collision.
    const tmpSlug = `tmpl-smoke-${Date.now()}`;
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const tmpSourcePath = path.join(
      repoRoot,
      'src',
      'self-bench',
      'experiments',
      `${tmpSlug}.ts`,
    );

    // Replace the hardcoded slug references so the file matches
    // the temp name.
    const adjusted = out.sourceContent
      .replace(/qwen-35b-latency/g, tmpSlug)
      .replace(/Qwen35bLatencyExperiment/g, 'TmplSmokeExperiment');

    fs.writeFileSync(tmpSourcePath, adjusted, 'utf-8');
    try {
      // Run tsc against just this file via the workspace tsconfig.
      // Any type error here means the template produced broken code.
      execSync('npx tsc --noEmit --skipLibCheck', {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } finally {
      try { fs.unlinkSync(tmpSourcePath); } catch { /* ignore */ }
    }
  });

  it('migration_schema_probe generated source compiles against the real Experiment interface', () => {
    const out = fillExperimentTemplate(goodMigrationBrief);
    const tmpSlug = `mig-smoke-${Date.now()}`;
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const tmpSourcePath = path.join(
      repoRoot,
      'src',
      'self-bench',
      'experiments',
      `${tmpSlug}.ts`,
    );

    const adjusted = out.sourceContent
      .replace(/migration-schema-016-dashboard-tables/g, tmpSlug)
      .replace(/MigrationSchema016DashboardTablesExperiment/g, 'MigSmokeExperiment');

    fs.writeFileSync(tmpSourcePath, adjusted, 'utf-8');
    try {
      execSync('npx tsc --noEmit --skipLibCheck', {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } finally {
      try { fs.unlinkSync(tmpSourcePath); } catch { /* ignore */ }
    }
  });
});
