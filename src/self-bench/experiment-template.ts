/**
 * Phase 7-B: constrained experiment template + slot filler.
 *
 * The generation primitive that turns a structured
 * ExperimentBrief into a pair of TypeScript source files (the
 * experiment implementation + its unit test). Takes the creative
 * latitude of "write an experiment" out of LLM hands for Phase 7
 * and hands the LLM a rigid shape instead — only specific slots
 * are fillable, the interface/imports/error handling are locked.
 *
 * Scope of a single template
 * --------------------------
 * The first template covered here is ModelLatencyProbe: an
 * experiment that queries llm_calls for a specific model, computes
 * rolling p50 latency, and flags concerning deviation from a
 * threshold. All templates share the same structural skeleton:
 *
 *   class <SlotClassName> implements Experiment {
 *     id = <slot:id>;
 *     name = <slot:name>;
 *     category = '<slot:category>' as const;
 *     hypothesis = <slot:hypothesis>;
 *     cadence = { everyMs: <slot:everyMs>, runOnBoot: false };
 *
 *     async probe(ctx) {
 *       // <slot:probe_body> — templated with strict shape
 *     }
 *     judge(result, _history) {
 *       // <slot:judge_body> — simple threshold check
 *     }
 *   }
 *
 * The slots are narrow on purpose. Future templates will add
 * intervene/validate/rollback shapes. For Phase 7-B we cover
 * observation-only experiments — the easiest to generate safely.
 *
 * Why not just have the LLM write the whole file
 * ----------------------------------------------
 * Free-form source generation is a moving target. The LLM has to
 * remember import paths, type annotations, error handling,
 * eslint rules, and the exact Experiment interface shape. Any
 * drift fails the typecheck gate and burns a full self-commit
 * cycle. A template pins all of that and makes the LLM's job
 * "fill in the numbers" not "write the program."
 */

/**
 * The structured brief that drives template filling. Produced by
 * ExperimentProposalGenerator (Phase 7-C) or a future LLM-backed
 * brief generator. Every field is a string or primitive so the
 * brief can live in a self_findings.evidence JSON column.
 */
export interface ExperimentBrief {
  /** Kebab-case slug for the experiment id, used as the file name. */
  slug: string;
  /** Human-readable experiment name. */
  name: string;
  /** One-sentence hypothesis. */
  hypothesis: string;
  /** Cadence in milliseconds. */
  everyMs: number;
  /**
   * Template variant. Grows one rule at a time:
   *   Phase 7-B: 'model_latency_probe'
   *   Phase 7-C Rule 2: 'migration_schema_probe'
   *   Phase 7-C Rule 3+4: 'subprocess_health_probe'
   */
  template: 'model_latency_probe' | 'migration_schema_probe' | 'subprocess_health_probe';
  /** Template-specific parameters. Shape depends on `template`. */
  params:
    | ModelLatencyProbeParams
    | MigrationSchemaProbeParams
    | SubprocessHealthProbeParams
    | Record<string, unknown>;
}

/** Parameters for the model_latency_probe template. */
export interface ModelLatencyProbeParams {
  /** The model id to probe (e.g. "qwen/qwen3.5-35b-a3b"). */
  model_id: string;
  /** Rolling sample size for the p50 computation. */
  sample_size: number;
  /** Above this latency (ms), verdict becomes 'warning'. */
  warn_latency_ms: number;
  /** Above this latency (ms), verdict becomes 'fail'. */
  fail_latency_ms: number;
  /** Minimum sample count before a verdict can be returned. */
  min_samples: number;
}

/**
 * Parameters for the migration_schema_probe template. Produced by
 * the proposal generator's migration-scan rule: it reads one
 * src/db/migrations/<file>.sql at generation time, regex-extracts
 * every `CREATE TABLE [IF NOT EXISTS] <name>` statement, and stamps
 * the list into the brief. The generated experiment then verifies
 * those tables still exist in the live sqlite schema every tick.
 * Read-only — the probe issues a single `SELECT name FROM
 * sqlite_master WHERE type='table'` and compares set membership.
 */
export interface MigrationSchemaProbeParams {
  /** Basename of the migration file, e.g. "016-dashboard-tables.sql". */
  migration_file: string;
  /**
   * Table names the migration creates. Each must match
   * /^[a-zA-Z_][a-zA-Z0-9_]*$/ so the brief never embeds anything
   * weird into the generated source file. Capped at 50 entries.
   */
  expected_tables: string[];
}

/**
 * Parameters for the subprocess_health_probe template. Produced by
 * the proposal generator's toolchain-singleton rule (Rule 3) and the
 * missing-tool-test rule (Rule 4). The generated experiment runs the
 * command in the repo root via execSync, captures exit code and
 * truncated output, and records a pass/fail finding. Read-only in
 * practice — allowlisted commands are all non-mutating (typecheck,
 * lint, test). No DB access needed; the probe is a pure subprocess
 * health check.
 */
export interface SubprocessHealthProbeParams {
  /**
   * The shell command to run. Must start with one of the allowed
   * prefixes so the generated experiment can't be weaponised to run
   * arbitrary code. Validated by validateBrief.
   */
  command: string;
  /** Short human-readable label, e.g. "TypeScript type checker". */
  description: string;
  /**
   * How many lines of output to keep in the finding evidence.
   * Truncates both stdout and stderr independently. Range: 5..500.
   */
  capture_lines: number;
  /**
   * Subprocess timeout in milliseconds. Range: 10_000..600_000 (10s–10m).
   * Defaults baked in at proposal time: typecheck=180s, tests=300s, lint=120s.
   */
  timeout_ms: number;
}

export interface GeneratedExperimentFiles {
  /** Path of the experiment source file relative to repo root. */
  sourcePath: string;
  /** Contents of the experiment source file. */
  sourceContent: string;
  /** Path of the matching test file. */
  testPath: string;
  /** Contents of the test file. */
  testContent: string;
}

/**
 * Commands the subprocess_health_probe template is allowed to run.
 * Validated at brief-creation time so the generated source can only
 * ever invoke non-mutating build/check commands. Extend this list
 * when adding new probe types; never add commands that write files
 * (build, install) or mutate DB (migrations apply).
 */
export const SUBPROCESS_COMMAND_ALLOWLIST: readonly string[] = Object.freeze([
  'npm run typecheck',
  'npm run lint',
  'npm test',
  'npm run test',
  'npx tsc',
  'npx eslint',
  'npx vitest run',
]);

/**
 * Convert a slug like "qwen-35b-latency" into a class-safe
 * PascalCase identifier: "Qwen35bLatencyExperiment".
 */
function slugToClassName(slug: string): string {
  return (
    slug
      .split(/[^a-zA-Z0-9]+/)
      .filter((p) => p.length > 0)
      .map((p) => p[0].toUpperCase() + p.slice(1))
      .join('') + 'Experiment'
  );
}

/**
 * Convert a slug to a camelCase variable prefix.
 * "qwen-35b-latency" → "qwen35bLatency".
 */
function slugToCamel(slug: string): string {
  const parts = slug.split(/[^a-zA-Z0-9]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return 'exp';
  return parts[0].toLowerCase() + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join('');
}

/** Escape a string for inclusion inside a TypeScript single-quoted literal. */
function tsString(s: string): string {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
}

/**
 * Validate a brief before generation. Returns null on success,
 * error message on failure. The template filler calls this and
 * refuses to produce output for invalid briefs so garbage never
 * reaches the self-commit gate.
 */
export function validateBrief(brief: ExperimentBrief): string | null {
  if (!brief.slug || !/^[a-z][a-z0-9-]*$/.test(brief.slug)) {
    return 'slug must be kebab-case starting with a letter';
  }
  if (brief.slug.length > 50) return 'slug too long';
  if (!brief.name || brief.name.length > 200) return 'name missing or too long';
  if (!brief.hypothesis || brief.hypothesis.length > 500) return 'hypothesis missing or too long';
  if (typeof brief.everyMs !== 'number' || brief.everyMs < 60_000 || brief.everyMs > 24 * 60 * 60 * 1000) {
    return 'everyMs must be between 1 minute and 24 hours';
  }
  if (brief.template === 'model_latency_probe') {
    const p = brief.params as ModelLatencyProbeParams;
    if (!p.model_id || typeof p.model_id !== 'string' || p.model_id.length > 200) {
      return 'params.model_id missing or too long';
    }
    if (typeof p.sample_size !== 'number' || p.sample_size < 5 || p.sample_size > 1000) {
      return 'params.sample_size must be 5..1000';
    }
    if (typeof p.warn_latency_ms !== 'number' || p.warn_latency_ms < 1) {
      return 'params.warn_latency_ms must be > 0';
    }
    if (typeof p.fail_latency_ms !== 'number' || p.fail_latency_ms <= p.warn_latency_ms) {
      return 'params.fail_latency_ms must be > warn_latency_ms';
    }
    if (typeof p.min_samples !== 'number' || p.min_samples < 1 || p.min_samples > p.sample_size) {
      return 'params.min_samples must be 1..sample_size';
    }
    return null;
  }

  if (brief.template === 'migration_schema_probe') {
    const p = brief.params as MigrationSchemaProbeParams;
    if (!p.migration_file || typeof p.migration_file !== 'string' || p.migration_file.length > 200) {
      return 'params.migration_file missing or too long';
    }
    // Refuse migration paths, null bytes, or anything that isn't a
    // plain kebab-ish basename. The generator only ever passes a
    // basename, so anything else is either a bug or tampering.
    if (p.migration_file.includes('/') || p.migration_file.includes('\\') || p.migration_file.includes('..')) {
      return 'params.migration_file must be a bare basename';
    }
    if (!Array.isArray(p.expected_tables) || p.expected_tables.length === 0 || p.expected_tables.length > 50) {
      return 'params.expected_tables must be 1..50 entries';
    }
    const tableIdent = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    for (const t of p.expected_tables) {
      if (typeof t !== 'string' || !tableIdent.test(t) || t.length > 100) {
        return `params.expected_tables contains invalid table name: ${String(t).slice(0, 40)}`;
      }
    }
    return null;
  }

  if (brief.template === 'subprocess_health_probe') {
    const p = brief.params as SubprocessHealthProbeParams;
    if (!p.command || typeof p.command !== 'string' || p.command.length > 300) {
      return 'params.command missing or too long';
    }
    if (!SUBPROCESS_COMMAND_ALLOWLIST.some((prefix) => p.command.startsWith(prefix))) {
      return `params.command must start with one of: ${SUBPROCESS_COMMAND_ALLOWLIST.join(', ')}`;
    }
    if (!p.description || typeof p.description !== 'string' || p.description.length > 200) {
      return 'params.description missing or too long';
    }
    if (typeof p.capture_lines !== 'number' || p.capture_lines < 5 || p.capture_lines > 500) {
      return 'params.capture_lines must be 5..500';
    }
    if (typeof p.timeout_ms !== 'number' || p.timeout_ms < 10_000 || p.timeout_ms > 600_000) {
      return 'params.timeout_ms must be 10000..600000';
    }
    return null;
  }

  return `unknown template: ${(brief as { template?: unknown }).template}`;
}

/**
 * Fill the experiment template with the brief's parameters,
 * returning both source and test file contents + their target
 * paths. The caller passes this to safeSelfCommit.
 */
export function fillExperimentTemplate(brief: ExperimentBrief): GeneratedExperimentFiles {
  const err = validateBrief(brief);
  if (err) {
    throw new Error(`invalid brief: ${err}`);
  }

  if (brief.template === 'model_latency_probe') {
    return fillModelLatencyProbe(brief, brief.params as ModelLatencyProbeParams);
  }

  if (brief.template === 'migration_schema_probe') {
    return fillMigrationSchemaProbe(brief, brief.params as MigrationSchemaProbeParams);
  }

  if (brief.template === 'subprocess_health_probe') {
    return fillSubprocessHealthProbe(brief, brief.params as SubprocessHealthProbeParams);
  }

  throw new Error(`unknown template: ${(brief as { template?: unknown }).template}`);
}

function fillModelLatencyProbe(
  brief: ExperimentBrief,
  params: ModelLatencyProbeParams,
): GeneratedExperimentFiles {
  const className = slugToClassName(brief.slug);
  const camel = slugToCamel(brief.slug);
  const experimentId = brief.slug;

  const sourceContent = `/**
 * ${brief.name}
 *
 * AUTO-GENERATED by Phase 7-D ExperimentAuthorExperiment from a
 * brief in self_findings with category='experiment_proposal'.
 *
 * Hypothesis: ${brief.hypothesis}
 *
 * Template: model_latency_probe
 * Model: ${params.model_id}
 * Rolling sample: ${params.sample_size}
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

interface ${className}Evidence extends Record<string, unknown> {
  model: string;
  samples: number;
  p50_latency_ms: number;
  mean_latency_ms: number;
  max_latency_ms: number;
  min_samples_required: number;
  warn_threshold_ms: number;
  fail_threshold_ms: number;
}

interface ${className}Row {
  latency_ms: number;
}

export class ${className} implements Experiment {
  id = ${tsString(experimentId)};
  name = ${tsString(brief.name)};
  category = 'model_health' as const;
  hypothesis = ${tsString(brief.hypothesis)};
  cadence = { everyMs: ${brief.everyMs}, runOnBoot: false };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const { data } = await ctx.db
      .from<${className}Row>('llm_calls')
      .select('latency_ms')
      .eq('model', ${tsString(params.model_id)})
      .order('created_at', { ascending: false })
      .limit(${params.sample_size});

    const rows = (data ?? []) as ${className}Row[];
    const latencies = rows.map((r) => r.latency_ms).filter((v) => typeof v === 'number' && v >= 0);

    const samples = latencies.length;
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
    const mean = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
    const max = latencies.length > 0 ? Math.max(...latencies) : 0;

    const evidence: ${className}Evidence = {
      model: ${tsString(params.model_id)},
      samples,
      p50_latency_ms: p50,
      mean_latency_ms: mean,
      max_latency_ms: max,
      min_samples_required: ${params.min_samples},
      warn_threshold_ms: ${params.warn_latency_ms},
      fail_threshold_ms: ${params.fail_latency_ms},
    };

    const summary =
      samples < ${params.min_samples}
        ? \`insufficient samples for \${${tsString(params.model_id)}}: \${samples} < \${${params.min_samples}}\`
        : \`\${${tsString(params.model_id)}}: p50 \${p50}ms over \${samples} calls (warn=${params.warn_latency_ms}, fail=${params.fail_latency_ms})\`;

    return {
      subject: \`model:\${${tsString(params.model_id)}}\`,
      summary,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ${className}Evidence;
    if (ev.samples < ev.min_samples_required) return 'warning';
    if (ev.p50_latency_ms >= ev.fail_threshold_ms) return 'fail';
    if (ev.p50_latency_ms >= ev.warn_threshold_ms) return 'warning';
    return 'pass';
  }
}
`;

  const testContent = `import { describe, it, expect, vi } from 'vitest';
import { ${className} } from '../experiments/${brief.slug}.js';
import type { ExperimentContext, ProbeResult } from '../experiment-types.js';

function fakeDb(rows: Array<{ latency_ms: number }>) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  };
  return { from: () => chain };
}

function makeCtx(rows: Array<{ latency_ms: number }>): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: fakeDb(rows) as any,
    workspaceId: 'ws-test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async () => [],
  };
}

describe('${className} (auto-generated)', () => {
  const exp = new ${className}();

  it('returns warning when samples < min_samples', async () => {
    const rows = Array.from({ length: ${Math.max(0, params.min_samples - 1)} }, () => ({ latency_ms: 100 }));
    const result = await exp.probe(makeCtx(rows));
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('returns pass when p50 is below warn threshold', async () => {
    const rows = Array.from({ length: ${params.sample_size} }, () => ({ latency_ms: ${Math.max(1, Math.floor(params.warn_latency_ms / 2))} }));
    const result = await exp.probe(makeCtx(rows));
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('returns warning when p50 crosses warn threshold', async () => {
    const rows = Array.from({ length: ${params.sample_size} }, () => ({ latency_ms: ${params.warn_latency_ms + 1} }));
    const result = await exp.probe(makeCtx(rows));
    const ev = result.evidence as { p50_latency_ms: number };
    expect(ev.p50_latency_ms).toBeGreaterThanOrEqual(${params.warn_latency_ms});
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('returns fail when p50 crosses fail threshold', async () => {
    const rows = Array.from({ length: ${params.sample_size} }, () => ({ latency_ms: ${params.fail_latency_ms + 100} }));
    const result = await exp.probe(makeCtx(rows));
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('evidence exposes model + thresholds for operator audit', async () => {
    const rows = [{ latency_ms: 50 }];
    const result = await exp.probe(makeCtx(rows));
    const ev = result.evidence as { model: string; warn_threshold_ms: number; fail_threshold_ms: number };
    expect(ev.model).toBe(${tsString(params.model_id)});
    expect(ev.warn_threshold_ms).toBe(${params.warn_latency_ms});
    expect(ev.fail_threshold_ms).toBe(${params.fail_latency_ms});
  });
});
`;

  return {
    sourcePath: `src/self-bench/experiments/${brief.slug}.ts`,
    sourceContent,
    testPath: `src/self-bench/__tests__/${brief.slug}.test.ts`,
    testContent,
  };
}

function fillMigrationSchemaProbe(
  brief: ExperimentBrief,
  params: MigrationSchemaProbeParams,
): GeneratedExperimentFiles {
  const className = slugToClassName(brief.slug);
  const experimentId = brief.slug;
  // Emit the expected tables list as a frozen TS literal so the
  // generated source stays self-contained. Each element runs through
  // tsString for quote-escaping even though validateBrief already
  // constrained them to a strict identifier regex — belt + braces.
  const expectedTablesLiteral =
    '[' + params.expected_tables.map((t) => tsString(t)).join(', ') + ']';
  const expectedCount = params.expected_tables.length;
  const firstTable = params.expected_tables[0];
  const subjectLiteral = tsString(`migration:${params.migration_file}`);

  const sourceContent = `/**
 * ${brief.name}
 *
 * AUTO-GENERATED by Phase 7-D ExperimentAuthorExperiment from a
 * brief in self_findings with category='experiment_proposal'.
 *
 * Hypothesis: ${brief.hypothesis}
 *
 * Template: migration_schema_probe
 * Migration: ${params.migration_file}
 * Expected tables (${expectedCount}): ${params.expected_tables.join(', ')}
 *
 * Read-only schema-drift canary. Runs a single SELECT on
 * sqlite_master and asserts every table the migration was supposed
 * to create still exists in the live schema. Verdict=fail on any
 * missing table — the operator's tripwire for a silently dropped
 * or renamed table.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

interface ${className}Evidence extends Record<string, unknown> {
  migration_file: string;
  expected_tables: string[];
  present_count: number;
  missing_tables: string[];
}

interface ${className}Row {
  name: string | null;
}

const EXPECTED_TABLES: readonly string[] = Object.freeze(${expectedTablesLiteral});

export class ${className} implements Experiment {
  id = ${tsString(experimentId)};
  name = ${tsString(brief.name)};
  category = 'other' as const;
  hypothesis = ${tsString(brief.hypothesis)};
  cadence = { everyMs: ${brief.everyMs}, runOnBoot: false };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const { data } = await ctx.db
      .from<${className}Row>('sqlite_master')
      .select('name')
      .eq('type', 'table')
      .limit(1000);

    const rows = (data ?? []) as ${className}Row[];
    const present = new Set<string>();
    for (const row of rows) {
      if (typeof row.name === 'string' && row.name.length > 0) {
        present.add(row.name);
      }
    }

    const missing = EXPECTED_TABLES.filter((t) => !present.has(t));

    const evidence: ${className}Evidence = {
      migration_file: ${tsString(params.migration_file)},
      expected_tables: [...EXPECTED_TABLES],
      present_count: present.size,
      missing_tables: missing,
    };

    const summary =
      missing.length === 0
        ? \`\${EXPECTED_TABLES.length} expected table(s) present for \${${tsString(params.migration_file)}}\`
        : \`\${missing.length} missing table(s) for \${${tsString(params.migration_file)}}: \${missing.join(', ')}\`;

    return {
      subject: ${subjectLiteral},
      summary,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ${className}Evidence;
    if (ev.missing_tables.length > 0) return 'fail';
    return 'pass';
  }
}
`;

  const testContent = `import { describe, it, expect } from 'vitest';
import { ${className} } from '../experiments/${brief.slug}.js';
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

const EXPECTED = ${expectedTablesLiteral};

describe('${className} (auto-generated)', () => {
  const exp = new ${className}();

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
    const rows = [{ name: ${tsString(firstTable)} }];
    const result = await exp.probe(makeCtx(rows));
    const ev = result.evidence as { migration_file: string; expected_tables: string[] };
    expect(ev.migration_file).toBe(${tsString(params.migration_file)});
    expect(ev.expected_tables).toEqual(EXPECTED);
  });
});
`;

  return {
    sourcePath: `src/self-bench/experiments/${brief.slug}.ts`,
    sourceContent,
    testPath: `src/self-bench/__tests__/${brief.slug}.test.ts`,
    testContent,
  };
}

function fillSubprocessHealthProbe(
  brief: ExperimentBrief,
  params: SubprocessHealthProbeParams,
): GeneratedExperimentFiles {
  const className = slugToClassName(brief.slug);
  const experimentId = brief.slug;
  const subjectLiteral = tsString(`subprocess:${brief.slug}`);
  const halfLines = Math.max(3, Math.floor(params.capture_lines / 2));

  // These are values baked into the generated source at generation time.
  const cmdLiteral = tsString(params.command);
  const descStr = params.description.replace(/`/g, '\\`');
  const timeoutMs = params.timeout_ms;
  const everyMs = brief.everyMs;
  const hypLiteral = tsString(brief.hypothesis);
  const nameLiteral = tsString(brief.name);
  const idLiteral = tsString(experimentId);

  const sourceContent = [
    `/**`,
    ` * ${brief.name}`,
    ` *`,
    ` * AUTO-GENERATED by Phase 7-D ExperimentAuthorExperiment from a`,
    ` * brief in self_findings with category='experiment_proposal'.`,
    ` *`,
    ` * Hypothesis: ${brief.hypothesis}`,
    ` *`,
    ` * Template: subprocess_health_probe`,
    ` * Command: ${params.command}`,
    ` * Timeout: ${params.timeout_ms}ms`,
    ` */`,
    ``,
    `import { execSync } from 'node:child_process';`,
    `import type {`,
    `  Experiment,`,
    `  ExperimentContext,`,
    `  Finding,`,
    `  ProbeResult,`,
    `  Verdict,`,
    `} from '../experiment-types.js';`,
    `import { getSelfCommitStatus } from '../self-commit.js';`,
    ``,
    `interface ${className}Evidence extends Record<string, unknown> {`,
    `  command: string;`,
    `  exit_code: number;`,
    `  stdout_lines: string[];`,
    `  stderr_lines: string[];`,
    `  duration_ms: number;`,
    `  repo_root: string | null;`,
    `  error?: string;`,
    `}`,
    ``,
    `export class ${className} implements Experiment {`,
    `  id = ${idLiteral};`,
    `  name = ${nameLiteral};`,
    `  category = 'tool_reliability' as const;`,
    `  hypothesis = ${hypLiteral};`,
    `  cadence = { everyMs: ${everyMs}, runOnBoot: true };`,
    ``,
    `  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {`,
    `    const { repoRoot } = getSelfCommitStatus();`,
    `    const command = ${cmdLiteral};`,
    `    const startMs = Date.now();`,
    ``,
    `    if (!repoRoot) {`,
    `      const evidence: ${className}Evidence = {`,
    `        command,`,
    `        exit_code: -1,`,
    `        stdout_lines: [],`,
    `        stderr_lines: [],`,
    `        duration_ms: 0,`,
    `        repo_root: null,`,
    `        error: 'repo root not configured',`,
    `      };`,
    `      return {`,
    `        subject: ${subjectLiteral},`,
    `        summary: \`${descStr}: repo root unavailable\`,`,
    `        evidence,`,
    `      };`,
    `    }`,
    ``,
    `    let exitCode = 0;`,
    `    let stdout = '';`,
    `    let stderr = '';`,
    ``,
    `    try {`,
    `      stdout = execSync(command, {`,
    `        cwd: repoRoot,`,
    `        stdio: 'pipe',`,
    `        timeout: ${timeoutMs},`,
    `        encoding: 'utf-8',`,
    `      }).toString();`,
    `    } catch (err) {`,
    `      exitCode = (err as { status?: number }).status ?? 1;`,
    `      const execErr = err as { stdout?: Buffer | string; stderr?: Buffer | string };`,
    `      stdout = execErr.stdout ? String(execErr.stdout) : '';`,
    `      stderr = execErr.stderr ? String(execErr.stderr) : '';`,
    `      if (!stdout && !stderr && err instanceof Error) {`,
    `        stderr = err.message;`,
    `      }`,
    `    }`,
    ``,
    `    const durationMs = Date.now() - startMs;`,
    `    const stdoutLines = stdout.split('\\n').filter((l) => l.trim()).slice(-${halfLines});`,
    `    const stderrLines = stderr.split('\\n').filter((l) => l.trim()).slice(-${halfLines});`,
    ``,
    `    const evidence: ${className}Evidence = {`,
    `      command,`,
    `      exit_code: exitCode,`,
    `      stdout_lines: stdoutLines,`,
    `      stderr_lines: stderrLines,`,
    `      duration_ms: durationMs,`,
    `      repo_root: repoRoot,`,
    `    };`,
    ``,
    `    const summary =`,
    `      exitCode === 0`,
    `        ? \`${descStr}: passed in \${durationMs}ms\``,
    `        : \`${descStr}: failed (exit \${exitCode}) in \${durationMs}ms\`;`,
    ``,
    `    return {`,
    `      subject: ${subjectLiteral},`,
    `      summary,`,
    `      evidence,`,
    `    };`,
    `  }`,
    ``,
    `  judge(result: ProbeResult, _history: Finding[]): Verdict {`,
    `    const ev = result.evidence as ${className}Evidence;`,
    `    if (ev.repo_root === null) return 'warning';`,
    `    if (ev.exit_code !== 0) return 'fail';`,
    `    return 'pass';`,
    `  }`,
    `}`,
  ].join('\n');

  const testContent = [
    `import { describe, it, expect, vi, beforeEach } from 'vitest';`,
    `import type { ExperimentContext } from '../experiment-types.js';`,
    ``,
    `vi.mock('node:child_process', () => ({`,
    `  execSync: vi.fn(),`,
    `}));`,
    ``,
    `vi.mock('../self-commit.js', () => ({`,
    `  getSelfCommitStatus: vi.fn(() => ({`,
    `    killSwitchOpen: false,`,
    `    repoRootConfigured: true,`,
    `    repoRoot: '/fake/repo',`,
    `    allowedPathPrefixes: [],`,
    `    auditLogPath: '/fake/log',`,
    `  })),`,
    `}));`,
    ``,
    `import { execSync } from 'node:child_process';`,
    `import { getSelfCommitStatus } from '../self-commit.js';`,
    `import { ${className} } from '../experiments/${brief.slug}.js';`,
    ``,
    `function makeCtx(): ExperimentContext {`,
    `  return {`,
    `    // eslint-disable-next-line @typescript-eslint/no-explicit-any`,
    `    db: {} as any,`,
    `    workspaceId: 'ws-test',`,
    `    // eslint-disable-next-line @typescript-eslint/no-explicit-any`,
    `    engine: {} as any,`,
    `    recentFindings: async () => [],`,
    `  };`,
    `}`,
    ``,
    `describe('${className} (auto-generated)', () => {`,
    `  const exp = new ${className}();`,
    ``,
    `  beforeEach(() => {`,
    `    vi.mocked(getSelfCommitStatus).mockReturnValue({`,
    `      killSwitchOpen: false,`,
    `      repoRootConfigured: true,`,
    `      repoRoot: '/fake/repo',`,
    `      allowedPathPrefixes: [],`,
    `      auditLogPath: '/fake/log',`,
    `    });`,
    `  });`,
    ``,
    `  it('returns pass when command exits 0', async () => {`,
    `    vi.mocked(execSync).mockReturnValue(Buffer.from('all good\\n') as unknown as string);`,
    `    const result = await exp.probe(makeCtx());`,
    `    expect(exp.judge(result, [])).toBe('pass');`,
    `    const ev = result.evidence as { exit_code: number; command: string };`,
    `    expect(ev.exit_code).toBe(0);`,
    `    expect(ev.command).toBe(${cmdLiteral});`,
    `  });`,
    ``,
    `  it('returns fail when command exits non-zero', async () => {`,
    `    const err = Object.assign(new Error('failed'), {`,
    `      status: 1,`,
    `      stdout: Buffer.from('error output\\n'),`,
    `      stderr: Buffer.from('stderr line\\n'),`,
    `    });`,
    `    vi.mocked(execSync).mockImplementation(() => { throw err; });`,
    `    const result = await exp.probe(makeCtx());`,
    `    expect(exp.judge(result, [])).toBe('fail');`,
    `    const ev = result.evidence as { exit_code: number; stderr_lines: string[] };`,
    `    expect(ev.exit_code).toBe(1);`,
    `    expect(ev.stderr_lines.length).toBeGreaterThan(0);`,
    `  });`,
    ``,
    `  it('returns warning when repo root is unavailable', async () => {`,
    `    vi.mocked(getSelfCommitStatus).mockReturnValue({`,
    `      killSwitchOpen: false,`,
    `      repoRootConfigured: false,`,
    `      repoRoot: null,`,
    `      allowedPathPrefixes: [],`,
    `      auditLogPath: '/fake/log',`,
    `    });`,
    `    const result = await exp.probe(makeCtx());`,
    `    expect(exp.judge(result, [])).toBe('warning');`,
    `    const ev = result.evidence as { repo_root: null; error: string };`,
    `    expect(ev.repo_root).toBeNull();`,
    `    expect(ev.error).toContain('repo root');`,
    `  });`,
    ``,
    `  it('evidence exposes command and duration', async () => {`,
    `    vi.mocked(execSync).mockReturnValue(Buffer.from('') as unknown as string);`,
    `    const result = await exp.probe(makeCtx());`,
    `    const ev = result.evidence as { command: string; duration_ms: number };`,
    `    expect(ev.command).toBe(${cmdLiteral});`,
    `    expect(typeof ev.duration_ms).toBe('number');`,
    `  });`,
    `});`,
  ].join('\n');

  return {
    sourcePath: `src/self-bench/experiments/${brief.slug}.ts`,
    sourceContent,
    testPath: `src/self-bench/__tests__/${brief.slug}.test.ts`,
    testContent,
  };
}
