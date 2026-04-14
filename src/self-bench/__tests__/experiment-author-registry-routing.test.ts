/**
 * Tests for chooseRegistryRoute — the Layer-1 dispatcher that decides
 * whether a brief should land as a registry-row append or fall through
 * to the legacy templated TS file path.
 *
 * Pinning every routing decision so a future change to
 * fillExperimentTemplate or the proposal generator can't quietly
 * regress the slop-prevention guarantee.
 */

import { describe, it, expect } from 'vitest';
import { chooseRegistryRoute } from '../experiments/experiment-author.js';
import type { ExperimentBrief } from '../experiment-template.js';

function migrationBrief(
  overrides: Partial<{
    slug: string;
    migration_file: string;
    expected_tables: string[];
  }> = {},
): ExperimentBrief {
  return {
    slug: overrides.slug ?? 'migration-schema-200-fresh-table',
    name: 'Migration schema probe',
    hypothesis: 'h',
    template: 'migration_schema_probe',
    params: {
      migration_file: overrides.migration_file ?? '200-fresh-table.sql',
      expected_tables: overrides.expected_tables ?? ['fresh_table_one', 'fresh_table_two'],
    },
    everyMs: 3_600_000,
  } satisfies ExperimentBrief;
}

function subprocessBrief(command: string, slug = 'toolchain-subprocess-x'): ExperimentBrief {
  return {
    slug,
    name: 'Subprocess health',
    hypothesis: 'h',
    template: 'subprocess_health_probe',
    params: {
      command,
      description: 'd',
      capture_lines: 50,
      timeout_ms: 60_000,
    },
    everyMs: 21_600_000,
  } satisfies ExperimentBrief;
}

describe('chooseRegistryRoute — migration_schema_probe always routes', () => {
  it('routes to migration-schema registry with the correct row source', () => {
    const route = chooseRegistryRoute(migrationBrief());
    expect(route).not.toBeNull();
    expect(route!.registryPath).toBe(
      'src/self-bench/registries/migration-schema-registry.ts',
    );
    expect(route!.rowSource).toBe(
      "{ migrationFile: '200-fresh-table.sql', expectedTables: ['fresh_table_one', 'fresh_table_two'] }",
    );
    expect(route!.dedupeNeedle).toBe("'200-fresh-table.sql'");
  });

  it('escapes single quotes in migration file names defensively', () => {
    const route = chooseRegistryRoute(
      migrationBrief({ migration_file: "200-O'Brien.sql" }),
    );
    expect(route!.rowSource).toContain("'200-O\\'Brien.sql'");
  });

  it('emits a single-element table literal when only one table', () => {
    const route = chooseRegistryRoute(
      migrationBrief({ expected_tables: ['only_table'] }),
    );
    expect(route!.rowSource).toBe(
      "{ migrationFile: '200-fresh-table.sql', expectedTables: ['only_table'] }",
    );
  });
});

describe('chooseRegistryRoute — subprocess_health_probe is shape-dependent', () => {
  it('routes to toolchain-test registry when command matches the orchestrator-tool test pattern', () => {
    const route = chooseRegistryRoute(
      subprocessBrief('npx vitest run src/orchestrator/tools/__tests__/agents.test.ts'),
    );
    expect(route).not.toBeNull();
    expect(route!.registryPath).toBe(
      'src/self-bench/registries/toolchain-test-registry.ts',
    );
    expect(route!.rowSource).toBe("{ slug: 'agents' }");
    expect(route!.dedupeNeedle).toBe("'agents'");
  });

  it('extracts hyphenated slugs correctly', () => {
    const route = chooseRegistryRoute(
      subprocessBrief(
        'npx vitest run src/orchestrator/tools/__tests__/list-deliverables-since.test.ts',
      ),
    );
    expect(route!.rowSource).toBe("{ slug: 'list-deliverables-since' }");
  });

  it('falls through to TS file path for singleton commands (typecheck, lint, tests)', () => {
    expect(chooseRegistryRoute(subprocessBrief('npm run typecheck'))).toBeNull();
    expect(chooseRegistryRoute(subprocessBrief('npm run lint'))).toBeNull();
    expect(chooseRegistryRoute(subprocessBrief('npm test'))).toBeNull();
  });

  it('falls through for non-orchestrator-tool vitest commands', () => {
    // A test path outside src/orchestrator/tools/__tests__/ is not a
    // tool-coverage probe and shouldn't land in the toolchain registry.
    expect(
      chooseRegistryRoute(
        subprocessBrief('npx vitest run src/self-bench/__tests__/sample.test.ts'),
      ),
    ).toBeNull();
  });

  it('falls through for arbitrary shell commands', () => {
    expect(
      chooseRegistryRoute(subprocessBrief('echo hello')),
    ).toBeNull();
  });
});

describe('chooseRegistryRoute — unrelated templates return null', () => {
  it('returns null for model_latency_probe (always TS file path)', () => {
    const brief: ExperimentBrief = {
      slug: 'model-latency-foo',
      name: 'Model latency',
      hypothesis: 'h',
      template: 'model_latency_probe',
      params: {
        model_id: 'foo/bar',
        sample_size: 5,
        min_samples: 2,
        max_p95_ms: 1000,
      },
      everyMs: 3_600_000,
    } satisfies ExperimentBrief;
    expect(chooseRegistryRoute(brief)).toBeNull();
  });
});
