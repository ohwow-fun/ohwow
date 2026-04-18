import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  fillExperimentTemplate,
  validateBrief,
  SUBPROCESS_COMMAND_ALLOWLIST,
  type ExperimentBrief,
  type MigrationSchemaProbeParams,
  type ModelLatencyProbeParams,
  type SubprocessHealthProbeParams,
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
  // Compile all three probe templates in a single tsc invocation. tsc on the
  // full workspace is ~10s; running it three times tripled this file's
  // runtime for no added signal. Each template gets its own unique slug so
  // they coexist on disk during the check.
  it('all probe templates compile against the real Experiment interface', () => {
    const stamp = Date.now();
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const expDir = path.join(repoRoot, 'src', 'self-bench', 'experiments');

    const subprocessBrief: ExperimentBrief = {
      slug: 'toolchain-typecheck',
      name: 'TypeScript type checker health',
      hypothesis: 'npm run typecheck exits with code 0 on every run.',
      everyMs: 30 * 60 * 1000,
      template: 'subprocess_health_probe',
      params: {
        command: 'npm run typecheck',
        description: 'TypeScript type checker (npm run typecheck)',
        capture_lines: 50,
        timeout_ms: 3 * 60 * 1000,
      } satisfies SubprocessHealthProbeParams,
    };

    const specs = [
      {
        brief: goodBrief,
        slug: `tmpl-smoke-${stamp}`,
        slugFrom: /qwen-35b-latency/g,
        classFrom: /Qwen35bLatencyExperiment/g,
        className: 'TmplSmokeExperiment',
      },
      {
        brief: goodMigrationBrief,
        slug: `mig-smoke-${stamp}`,
        slugFrom: /migration-schema-016-dashboard-tables/g,
        classFrom: /MigrationSchema016DashboardTablesExperiment/g,
        className: 'MigSmokeExperiment',
      },
      {
        brief: subprocessBrief,
        slug: `subprocess-smoke-${stamp}`,
        slugFrom: /toolchain-typecheck/g,
        classFrom: /ToolchainTypecheckExperiment/g,
        className: 'SubprocessSmokeExperiment',
      },
    ];

    const writtenPaths: string[] = [];
    try {
      for (const s of specs) {
        const out = fillExperimentTemplate(s.brief);
        const adjusted = out.sourceContent
          .replace(s.slugFrom, s.slug)
          .replace(s.classFrom, s.className);
        const p = path.join(expDir, `${s.slug}.ts`);
        fs.writeFileSync(p, adjusted, 'utf-8');
        writtenPaths.push(p);
      }
      // One tsc run covers all three. Any type error means at least one
      // template emitted broken code.
      execSync('npx tsc --noEmit --skipLibCheck', {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } finally {
      for (const p of writtenPaths) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    }
  });
});

const goodSubprocessBrief: ExperimentBrief = {
  slug: 'toolchain-typecheck',
  name: 'TypeScript type checker health',
  hypothesis: 'npm run typecheck exits with code 0 on every run.',
  everyMs: 30 * 60 * 1000,
  template: 'subprocess_health_probe',
  params: {
    command: 'npm run typecheck',
    description: 'TypeScript type checker (npm run typecheck)',
    capture_lines: 50,
    timeout_ms: 3 * 60 * 1000,
  } satisfies SubprocessHealthProbeParams,
};

describe('validateBrief — subprocess_health_probe', () => {
  it('accepts a well-formed subprocess brief', () => {
    expect(validateBrief(goodSubprocessBrief)).toBeNull();
  });

  it('rejects a command not in the allowlist', () => {
    const b: ExperimentBrief = {
      ...goodSubprocessBrief,
      params: { ...(goodSubprocessBrief.params as SubprocessHealthProbeParams), command: 'rm -rf /' },
    };
    expect(validateBrief(b)).toContain('params.command must start with');
  });

  it('accepts every command in SUBPROCESS_COMMAND_ALLOWLIST', () => {
    for (const cmd of SUBPROCESS_COMMAND_ALLOWLIST) {
      const b: ExperimentBrief = {
        ...goodSubprocessBrief,
        slug: `toolchain-typecheck`, // reuse; slug validity isn't under test here
        params: { ...(goodSubprocessBrief.params as SubprocessHealthProbeParams), command: cmd },
      };
      expect(validateBrief(b)).toBeNull();
    }
  });

  it('rejects an empty description', () => {
    const b: ExperimentBrief = {
      ...goodSubprocessBrief,
      params: { ...(goodSubprocessBrief.params as SubprocessHealthProbeParams), description: '' },
    };
    expect(validateBrief(b)).toContain('description');
  });

  it('rejects capture_lines below 5', () => {
    const b: ExperimentBrief = {
      ...goodSubprocessBrief,
      params: { ...(goodSubprocessBrief.params as SubprocessHealthProbeParams), capture_lines: 2 },
    };
    expect(validateBrief(b)).toContain('capture_lines');
  });

  it('rejects timeout_ms below 10000', () => {
    const b: ExperimentBrief = {
      ...goodSubprocessBrief,
      params: { ...(goodSubprocessBrief.params as SubprocessHealthProbeParams), timeout_ms: 1000 },
    };
    expect(validateBrief(b)).toContain('timeout_ms');
  });

  it('rejects timeout_ms above 600000', () => {
    const b: ExperimentBrief = {
      ...goodSubprocessBrief,
      params: { ...(goodSubprocessBrief.params as SubprocessHealthProbeParams), timeout_ms: 700_000 },
    };
    expect(validateBrief(b)).toContain('timeout_ms');
  });
});

describe('fillExperimentTemplate — subprocess_health_probe', () => {
  it('returns expected source and test paths', () => {
    const out = fillExperimentTemplate(goodSubprocessBrief);
    expect(out.sourcePath).toBe('src/self-bench/experiments/toolchain-typecheck.ts');
    expect(out.testPath).toBe('src/self-bench/__tests__/toolchain-typecheck.test.ts');
  });

  it('embeds the command and description in source', () => {
    const out = fillExperimentTemplate(goodSubprocessBrief);
    expect(out.sourceContent).toContain('npm run typecheck');
    expect(out.sourceContent).toContain('TypeScript type checker (npm run typecheck)');
  });

  it('includes AUTO-GENERATED marker', () => {
    const out = fillExperimentTemplate(goodSubprocessBrief);
    expect(out.sourceContent).toContain('AUTO-GENERATED');
  });

  it('emits a class derived from the slug', () => {
    const out = fillExperimentTemplate(goodSubprocessBrief);
    expect(out.sourceContent).toContain('class ToolchainTypecheckExperiment');
    expect(out.testContent).toContain('ToolchainTypecheckExperiment');
  });

  it('test content includes pass and fail cases', () => {
    const out = fillExperimentTemplate(goodSubprocessBrief);
    expect(out.testContent).toContain("toBe('pass')");
    expect(out.testContent).toContain("toBe('fail')");
  });

  it('throws on invalid brief', () => {
    const bad: ExperimentBrief = {
      ...goodSubprocessBrief,
      params: {
        ...(goodSubprocessBrief.params as SubprocessHealthProbeParams),
        command: 'rm -rf /',
      },
    };
    expect(() => fillExperimentTemplate(bad)).toThrow('invalid brief');
  });
});
