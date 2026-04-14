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
  /** Template variant. Phase 7-B ships only 'model_latency_probe'. */
  template: 'model_latency_probe';
  /** Template-specific parameters. Shape depends on `template`. */
  params: ModelLatencyProbeParams | Record<string, unknown>;
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
  if (brief.template !== 'model_latency_probe') {
    return `unknown template: ${brief.template}`;
  }
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

  throw new Error(`unknown template: ${brief.template}`);
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
