import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExperimentProposalGenerator } from '../experiments/experiment-proposal-generator.js';
import type { Experiment, ExperimentContext } from '../experiment-types.js';
import { setSelfCommitRepoRoot } from '../self-commit.js';
import { validateBrief } from '../experiment-template.js';

/**
 * DB stub supporting:
 *   .from('llm_calls').select(...).gte('created_at', val).limit(n)
 *   .from('self_findings').select(...).eq('category', 'experiment_proposal').gte(...).limit(...)
 *   .from('self_findings').insert(row)  — from intervene's writeFinding calls
 *
 * Bucketed by table so different calls get different data.
 */
function buildDb(seed: {
  llm_calls?: Array<Record<string, unknown>>;
  existing_proposals?: Array<Record<string, unknown>>;
}) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    llm_calls: seed.llm_calls ?? [],
    self_findings: seed.existing_proposals ?? [],
  };

  function makeBuilder(table: string) {
    const filters: Array<{ col: string; op: 'eq' | 'gte'; val: unknown }> = [];
    let limitN: number | null = null;

    const apply = () => {
      let out = tables[table].filter((row) =>
        filters.every((f) => {
          if (f.op === 'eq') return row[f.col] === f.val;
          if (f.op === 'gte') return String(row[f.col] ?? '') >= String(f.val);
          return true;
        }),
      );
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };

    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => { filters.push({ col, op: 'eq', val }); return builder; };
    builder.gte = (col: string, val: unknown) => { filters.push({ col, op: 'gte', val }); return builder; };
    builder.limit = (n: number) => {
      limitN = n;
      return Promise.resolve({ data: apply(), error: null });
    };
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: apply(), error: null });
    builder.insert = (row: Record<string, unknown>) => {
      tables[table].push({ ...row });
      return Promise.resolve({ data: null, error: null });
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

/**
 * Returns existing_proposals rows for all three toolchain singleton slugs
 * so the dedupe set suppresses Rule 3 during Rule 1 / Rule 2 test cases.
 * Without this pre-seeding, Rule 3 ALWAYS emits 3 new proposals (it needs
 * no repo root), which changes proposal counts and judge verdicts.
 */
function toolchainSeeds(): Array<Record<string, unknown>> {
  return ['toolchain-typecheck', 'toolchain-lint', 'toolchain-tests'].map((slug, i) => ({
    id: `tc-seed-${i}`,
    experiment_id: 'experiment-proposal-generator',
    category: 'experiment_proposal',
    subject: `proposal:${slug}`,
    ran_at: new Date().toISOString(),
  }));
}

function llmCall(model: string, latencyMs: number, agoHours = 1) {
  return {
    model,
    latency_ms: latencyMs,
    created_at: new Date(Date.now() - agoHours * 60 * 60 * 1000).toISOString(),
  };
}

describe('ExperimentProposalGenerator', () => {
  const exp: Experiment = new ExperimentProposalGenerator();

  // Rule 2 (migration scan) reads getSelfCommitStatus().repoRoot.
  // Existing Rule 1 tests should not depend on the real repo being
  // reachable, so null the override for this block and save/restore
  // OHWOW_REPO_ROOT to keep the two rules independent.
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.OHWOW_REPO_ROOT;
    delete process.env.OHWOW_REPO_ROOT;
    setSelfCommitRepoRoot(null);
  });
  afterEach(() => {
    if (savedEnv !== undefined) process.env.OHWOW_REPO_ROOT = savedEnv;
    setSelfCommitRepoRoot(null);
  });

  it('warning verdict when no llm_calls rows exist and no migrations readable', async () => {
    // Pre-seed toolchains so Rule 3 is silent, then confirm warning.
    const env = buildDb({ existing_proposals: toolchainSeeds() });
    const result = await exp.probe(makeCtx(env));
    expect(result.summary).toContain('no llm_calls');
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('skips models with fewer than MIN_CALLS_FOR_PROPOSAL samples', async () => {
    // MIN_CALLS_FOR_PROPOSAL is 5 — use 3 samples to be below the floor.
    // Pre-seed toolchains so Rule 3 doesn't add noise to the proposal count.
    const env = buildDb({
      llm_calls: Array.from({ length: 3 }, () => llmCall('small/sample', 100)),
      existing_proposals: toolchainSeeds(),
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { new_proposals: number; skipped_due_to_low_samples: number };
    expect(ev.new_proposals).toBe(0);
    expect(ev.skipped_due_to_low_samples).toBe(1);
  });

  it('clamps min_samples to sample_size for low-traffic models (validateBrief invariant)', async () => {
    // Model with 6 samples — above the 5-sample floor, below the
    // default hardcoded min_samples of 10. The generator must
    // clamp min_samples so validateBrief passes (min_samples <= sample_size).
    // Pre-seed toolchains so proposals array contains only the one model probe.
    const env = buildDb({
      llm_calls: Array.from({ length: 6 }, (_, i) => llmCall('low/traffic', 500 + i * 100)),
      existing_proposals: toolchainSeeds(),
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { proposals: Array<{ params: { sample_size: number; min_samples: number } }> };
    expect(ev.proposals).toHaveLength(1);
    const params = ev.proposals[0].params;
    expect(params.sample_size).toBe(6);
    expect(params.min_samples).toBe(6); // clamped from 10 down to sample_size
    expect(params.min_samples).toBeLessThanOrEqual(params.sample_size);
  });

  it('proposes a latency probe for a model with enough samples', async () => {
    const env = buildDb({
      llm_calls: Array.from({ length: 30 }, (_, i) => llmCall('qwen/qwen3.5-35b-a3b', 1000 + i * 50)),
      existing_proposals: toolchainSeeds(),
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      new_proposals: number;
      proposals: Array<{ slug: string; template: string; params: Record<string, unknown> }>;
    };
    expect(ev.new_proposals).toBe(1);
    expect(ev.proposals[0].slug).toBe('qwen-qwen3-5-35b-a3b-latency');
    expect(ev.proposals[0].template).toBe('model_latency_probe');
    expect(ev.proposals[0].params.model_id).toBe('qwen/qwen3.5-35b-a3b');
  });

  it('derives warn/fail thresholds from observed distribution', async () => {
    const env = buildDb({
      // 30 samples ascending 1000..2450 (step 50ms)
      llm_calls: Array.from({ length: 30 }, (_, i) => llmCall('acme/model', 1000 + i * 50)),
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { proposals: Array<{ params: { warn_latency_ms: number; fail_latency_ms: number } }> };
    const p = ev.proposals[0].params;
    // p90 of ascending 1000..2450 is around 2350-2450 range
    expect(p.warn_latency_ms).toBeGreaterThanOrEqual(2000);
    // fail must be strictly greater than warn
    expect(p.fail_latency_ms).toBeGreaterThan(p.warn_latency_ms);
  });

  it('dedupe: does NOT re-propose a slug already in the ledger', async () => {
    const env = buildDb({
      llm_calls: Array.from({ length: 30 }, () => llmCall('qwen/qwen3.5-35b-a3b', 1500)),
      existing_proposals: [
        {
          id: 'old-1',
          experiment_id: 'experiment-proposal-generator',
          category: 'experiment_proposal',
          subject: 'proposal:qwen-qwen3-5-35b-a3b-latency',
          ran_at: new Date().toISOString(),
        },
        ...toolchainSeeds(),
      ],
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { new_proposals: number; existing_proposals: number };
    expect(ev.new_proposals).toBe(0);
    expect(ev.existing_proposals).toBe(4); // 1 latency + 3 toolchain
  });

  it('intervene writes one self_findings row per new proposal', async () => {
    // Pre-seed toolchain slugs so only the two model probes are "new".
    const env = buildDb({
      llm_calls: [
        ...Array.from({ length: 30 }, () => llmCall('a/model', 500)),
        ...Array.from({ length: 30 }, () => llmCall('b/model', 1000)),
      ],
      existing_proposals: toolchainSeeds(),
    });
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('pass', result, ctx);
    expect(intervention).not.toBeNull();
    const details = intervention!.details as { proposal_count: number; slugs: string[] };
    expect(details.proposal_count).toBe(2);
    expect(details.slugs.sort()).toEqual(['a-model-latency', 'b-model-latency']);
    // Two rows written to self_findings for the model probes specifically
    const proposalRows = env.tables.self_findings.filter(
      (r) => r.category === 'experiment_proposal' &&
        (String(r.subject ?? '').includes('a-model-latency') ||
          String(r.subject ?? '').includes('b-model-latency')),
    );
    expect(proposalRows).toHaveLength(2);
  });

  it('each proposal finding embeds a valid ExperimentBrief in evidence', async () => {
    const env = buildDb({
      llm_calls: Array.from({ length: 30 }, () => llmCall('qwen/qwen3.5-35b-a3b', 1500)),
      existing_proposals: toolchainSeeds(),
    });
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    await exp.intervene!('pass', result, ctx);
    // Find the latency proposal specifically (toolchain seeds in self_findings have no evidence)
    const proposal = env.tables.self_findings.find(
      (r) => r.category === 'experiment_proposal' &&
        String(r.subject ?? '').includes('qwen-qwen3-5-35b-a3b-latency'),
    );
    expect(proposal).toBeDefined();
    const evidence = JSON.parse(proposal!.evidence as string);
    expect(evidence.is_experiment_proposal).toBe(true);
    expect(evidence.claimed).toBe(false);
    expect(evidence.brief.template).toBe('model_latency_probe');
    expect(evidence.brief.slug).toBe('qwen-qwen3-5-35b-a3b-latency');
    expect(evidence.brief.params.model_id).toBe('qwen/qwen3.5-35b-a3b');
  });

  it('intervene returns null when no new proposals were generated', async () => {
    const env = buildDb({
      llm_calls: Array.from({ length: 30 }, () => llmCall('qwen/qwen3.5-35b-a3b', 1500)),
      existing_proposals: [
        {
          id: 'old-1',
          experiment_id: 'experiment-proposal-generator',
          category: 'experiment_proposal',
          subject: 'proposal:qwen-qwen3-5-35b-a3b-latency',
          ran_at: new Date().toISOString(),
        },
        ...toolchainSeeds(),
      ],
    });
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('pass', result, ctx);
    expect(intervention).toBeNull();
  });

  it('generated briefs pass validateBrief (end-to-end template compatibility)', async () => {
    const env = buildDb({
      llm_calls: Array.from({ length: 30 }, (_, i) => llmCall('valid/model-id', 800 + i * 10)),
      existing_proposals: toolchainSeeds(),
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { proposals: Array<unknown> };
    for (const brief of ev.proposals) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = validateBrief(brief as any);
      expect(err).toBeNull();
    }
  });
});

/**
 * Rule 2 — migration_schema_probe. Tests use a temp directory as
 * the fake repo root so each case controls its own migration set.
 * setSelfCommitRepoRoot() overrides getSelfCommitStatus().repoRoot,
 * which is what the rule reads. Env var OHWOW_REPO_ROOT is also
 * saved+cleared so it can't leak the real repo root into a case
 * that's testing the "no repo root" branch.
 */
describe('ExperimentProposalGenerator — Rule 2 (migration_schema_probe)', () => {
  const exp: Experiment = new ExperimentProposalGenerator();
  let tempRoot: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-mig-'));
    fs.mkdirSync(path.join(tempRoot, 'src', 'db', 'migrations'), { recursive: true });
    savedEnv = process.env.OHWOW_REPO_ROOT;
    delete process.env.OHWOW_REPO_ROOT;
    setSelfCommitRepoRoot(tempRoot);
  });

  afterEach(() => {
    setSelfCommitRepoRoot(null);
    if (savedEnv !== undefined) process.env.OHWOW_REPO_ROOT = savedEnv;
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function writeMigration(name: string, body: string) {
    fs.writeFileSync(
      path.join(tempRoot, 'src', 'db', 'migrations', name),
      body,
      'utf-8',
    );
  }

  it('emits one migration_schema_probe brief per file with CREATE TABLE', async () => {
    writeMigration('001-foo.sql', 'CREATE TABLE IF NOT EXISTS foo_table (id TEXT);');
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      migrations_scanned: number;
      new_migration_proposals: number;
      proposals: Array<{
        template: string;
        slug: string;
        params: { migration_file: string; expected_tables: string[] };
      }>;
    };
    expect(ev.migrations_scanned).toBe(1);
    expect(ev.new_migration_proposals).toBe(1);
    const brief = ev.proposals.find((p) => p.template === 'migration_schema_probe');
    expect(brief).toBeDefined();
    expect(brief!.slug).toBe('migration-schema-001-foo');
    expect(brief!.params.migration_file).toBe('001-foo.sql');
    expect(brief!.params.expected_tables).toEqual(['foo_table']);
  });

  it('skips migrations with no CREATE TABLE (ALTER-only)', async () => {
    writeMigration('002-alter.sql', 'ALTER TABLE foo ADD COLUMN bar TEXT;');
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      migrations_scanned: number;
      migration_files_with_tables: number;
      new_migration_proposals: number;
    };
    expect(ev.migrations_scanned).toBe(1);
    expect(ev.migration_files_with_tables).toBe(0);
    expect(ev.new_migration_proposals).toBe(0);
  });

  it('parses multiple CREATE TABLE statements and dedupes within a file', async () => {
    writeMigration(
      '003-multi.sql',
      `CREATE TABLE IF NOT EXISTS users (id TEXT);
       CREATE TABLE sessions (id TEXT);
       CREATE TABLE IF NOT EXISTS users (id TEXT);`,
    );
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      proposals: Array<{
        template: string;
        params: { expected_tables: string[] };
      }>;
    };
    const brief = ev.proposals.find((p) => p.template === 'migration_schema_probe');
    expect(brief).toBeDefined();
    expect(brief!.params.expected_tables).toEqual(['users', 'sessions']);
  });

  it('caps at MAX_MIGRATION_PROPOSALS_PER_TICK (3) per tick', async () => {
    for (let i = 1; i <= 10; i++) {
      const n = String(i).padStart(3, '0');
      writeMigration(`${n}-t.sql`, `CREATE TABLE IF NOT EXISTS t${i} (id TEXT);`);
    }
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { new_migration_proposals: number };
    expect(ev.new_migration_proposals).toBe(3);
  });

  it('newest-first ordering: highest-numbered migrations picked first when capped', async () => {
    for (let i = 1; i <= 6; i++) {
      const n = String(i).padStart(3, '0');
      writeMigration(`${n}-t.sql`, `CREATE TABLE IF NOT EXISTS t${i} (id TEXT);`);
    }
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      proposals: Array<{
        template: string;
        params: { migration_file: string };
      }>;
    };
    const migBriefs = ev.proposals.filter(
      (p) => p.template === 'migration_schema_probe',
    );
    expect(migBriefs).toHaveLength(3);
    expect(migBriefs[0].params.migration_file).toBe('006-t.sql');
    expect(migBriefs[1].params.migration_file).toBe('005-t.sql');
    expect(migBriefs[2].params.migration_file).toBe('004-t.sql');
  });

  it('dedupes against existing proposal slugs in the ledger', async () => {
    writeMigration('004-dash.sql', 'CREATE TABLE IF NOT EXISTS dash (id TEXT);');
    const env = buildDb({
      existing_proposals: [
        {
          id: 'prior',
          experiment_id: 'experiment-proposal-generator',
          category: 'experiment_proposal',
          subject: 'proposal:migration-schema-004-dash',
          ran_at: new Date().toISOString(),
        },
      ],
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { new_migration_proposals: number };
    expect(ev.new_migration_proposals).toBe(0);
  });

  it('generated migration briefs pass validateBrief', async () => {
    writeMigration(
      '005-valid.sql',
      'CREATE TABLE IF NOT EXISTS valid_table (id TEXT); CREATE TABLE IF NOT EXISTS other_table (id TEXT);',
    );
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { proposals: Array<unknown> };
    for (const brief of ev.proposals) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(validateBrief(brief as any)).toBeNull();
    }
  });

  it('flags repo_root_unavailable when no repo root is configured', async () => {
    setSelfCommitRepoRoot(null);
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      migration_repo_root_unavailable: boolean;
      migrations_scanned: number;
      new_migration_proposals: number;
    };
    expect(ev.migration_repo_root_unavailable).toBe(true);
    expect(ev.migrations_scanned).toBe(0);
    expect(ev.new_migration_proposals).toBe(0);
  });

  it('intervene writes a self_findings row for migration briefs too', async () => {
    writeMigration('007-int.sql', 'CREATE TABLE IF NOT EXISTS int_table (id TEXT);');
    const env = buildDb({});
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('pass', result, ctx);
    expect(intervention).not.toBeNull();
    const rows = env.tables.self_findings.filter(
      (r) => r.category === 'experiment_proposal',
    );
    const migRow = rows.find((r) =>
      String(r.subject ?? '').includes('migration-schema-007-int'),
    );
    expect(migRow).toBeDefined();
    const evidence = JSON.parse(migRow!.evidence as string);
    expect(evidence.brief.template).toBe('migration_schema_probe');
    expect(evidence.brief.params.expected_tables).toEqual(['int_table']);
  });
});

/**
 * Rule 3 — subprocess_health_probe toolchain singletons.
 * Repo root is nulled out so Rule 2 and Rule 4 stay silent and
 * only the hardcoded toolchain slugs are in play.
 */
describe('ExperimentProposalGenerator — Rule 3 (toolchain singletons)', () => {
  const exp: Experiment = new ExperimentProposalGenerator();
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.OHWOW_REPO_ROOT;
    delete process.env.OHWOW_REPO_ROOT;
    setSelfCommitRepoRoot(null);
  });
  afterEach(() => {
    setSelfCommitRepoRoot(null);
    if (savedEnv !== undefined) process.env.OHWOW_REPO_ROOT = savedEnv;
  });

  it('proposes all three toolchain singletons on first run', async () => {
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      new_toolchain_proposals: number;
      proposals: Array<{ slug: string; template: string }>;
    };
    expect(ev.new_toolchain_proposals).toBe(3);
    const tcSlugs = ev.proposals
      .filter((p) => p.template === 'subprocess_health_probe')
      .map((p) => p.slug);
    expect(tcSlugs).toContain('toolchain-typecheck');
    expect(tcSlugs).toContain('toolchain-lint');
    expect(tcSlugs).toContain('toolchain-tests');
  });

  it('dedupes: does not re-propose slugs already in the ledger', async () => {
    const env = buildDb({
      existing_proposals: [
        {
          id: '1',
          experiment_id: 'experiment-proposal-generator',
          category: 'experiment_proposal',
          subject: 'proposal:toolchain-typecheck',
          ran_at: new Date().toISOString(),
        },
        {
          id: '2',
          experiment_id: 'experiment-proposal-generator',
          category: 'experiment_proposal',
          subject: 'proposal:toolchain-lint',
          ran_at: new Date().toISOString(),
        },
      ],
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { new_toolchain_proposals: number };
    // Only toolchain-tests is new
    expect(ev.new_toolchain_proposals).toBe(1);
  });

  it('generated toolchain briefs pass validateBrief', async () => {
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { proposals: Array<unknown> };
    for (const brief of ev.proposals) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(validateBrief(brief as any)).toBeNull();
    }
  });

  it('intervene writes one self_findings row per toolchain brief', async () => {
    const env = buildDb({});
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('pass', result, ctx);
    expect(intervention).not.toBeNull();
    const rows = env.tables.self_findings.filter(
      (r) => r.category === 'experiment_proposal',
    );
    const subjects = rows.map((r) => String(r.subject ?? '').replace('proposal:', ''));
    expect(subjects).toContain('toolchain-typecheck');
    expect(subjects).toContain('toolchain-lint');
    expect(subjects).toContain('toolchain-tests');
  });

  it('judge returns pass when toolchain proposals were generated', async () => {
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    expect(exp.judge(result, [])).toBe('pass');
  });
});

/**
 * Rule 4 — subprocess_health_probe for existing tool test coverage.
 * Rule 4 now scans src/orchestrator/tools/__tests__/*.test.ts for
 * files that ALREADY EXIST and proposes a probe per file. Previously
 * it scanned tool source files for gaps and proposed running missing
 * paths — those always failed because vitest on a non-existent file
 * exits non-zero. Fixed to only propose probes for real test files.
 */
describe('ExperimentProposalGenerator — Rule 4 (existing tool tests)', () => {
  const exp: Experiment = new ExperimentProposalGenerator();
  let tempRoot: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-tool-'));
    // Rule 4 only needs the __tests__ subdir (scans existing test files, not source files)
    fs.mkdirSync(path.join(tempRoot, 'src', 'orchestrator', 'tools', '__tests__'), {
      recursive: true,
    });
    // Rule 2 needs migrations dir; keep it empty so it adds no noise
    fs.mkdirSync(path.join(tempRoot, 'src', 'db', 'migrations'), { recursive: true });
    savedEnv = process.env.OHWOW_REPO_ROOT;
    delete process.env.OHWOW_REPO_ROOT;
    setSelfCommitRepoRoot(tempRoot);
  });

  afterEach(() => {
    setSelfCommitRepoRoot(null);
    if (savedEnv !== undefined) process.env.OHWOW_REPO_ROOT = savedEnv;
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function writeToolTest(name: string) {
    fs.writeFileSync(
      path.join(tempRoot, 'src', 'orchestrator', 'tools', '__tests__', `${name}.test.ts`),
      `// ${name} test stub`,
      'utf-8',
    );
  }

  it('proposes a subprocess probe for each existing test file', async () => {
    writeToolTest('bash');
    writeToolTest('filesystem');
    writeToolTest('agents');
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      tool_handlers_scanned: number;
      tool_handlers_missing_tests: number;
      new_tool_test_proposals: number;
      proposals: Array<{ template: string; slug: string; params: { command: string } }>;
    };
    // tool_handlers_scanned = number of test files found
    expect(ev.tool_handlers_scanned).toBe(3);
    // tool_handlers_missing_tests is always 0 (no longer tracked)
    expect(ev.tool_handlers_missing_tests).toBe(0);
    expect(ev.new_tool_test_proposals).toBe(3);
    const toolBriefs = ev.proposals.filter(
      (p) => p.template === 'subprocess_health_probe' &&
        p.slug.startsWith('toolchain-tool-test-'),
    );
    expect(toolBriefs).toHaveLength(3);
    const slugs = toolBriefs.map((p) => p.slug);
    expect(slugs).toContain('toolchain-tool-test-bash');
    expect(slugs).toContain('toolchain-tool-test-filesystem');
    expect(slugs).toContain('toolchain-tool-test-agents');
    const bashBrief = toolBriefs.find((p) => p.slug === 'toolchain-tool-test-bash');
    expect(bashBrief!.params.command).toContain('bash.test.ts');
  });

  it('emits no proposals when __tests__ dir is empty', async () => {
    // No test files written — directory exists but is empty
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      tool_handlers_scanned: number;
      new_tool_test_proposals: number;
    };
    expect(ev.tool_handlers_scanned).toBe(0);
    expect(ev.new_tool_test_proposals).toBe(0);
  });

  it('caps at MAX_TOOL_TEST_PROPOSALS_PER_TICK (3) per tick', async () => {
    for (const name of ['a-tool', 'b-tool', 'c-tool', 'd-tool', 'e-tool']) {
      writeToolTest(name);
    }
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      tool_handlers_scanned: number;
      new_tool_test_proposals: number;
    };
    expect(ev.tool_handlers_scanned).toBe(5);
    expect(ev.new_tool_test_proposals).toBe(3); // capped
  });

  it('dedupes against existing slugs in the ledger', async () => {
    writeToolTest('bash');
    const env = buildDb({
      existing_proposals: [
        {
          id: 'prior',
          experiment_id: 'experiment-proposal-generator',
          category: 'experiment_proposal',
          subject: 'proposal:toolchain-tool-test-bash',
          ran_at: new Date().toISOString(),
        },
      ],
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { new_tool_test_proposals: number };
    expect(ev.new_tool_test_proposals).toBe(0);
  });

  it('converts underscores to hyphens in test file slugs', async () => {
    writeToolTest('local_write_file');
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      proposals: Array<{ slug: string; template: string }>;
    };
    const toolBriefs = ev.proposals.filter(
      (p) => p.template === 'subprocess_health_probe' &&
        p.slug.startsWith('toolchain-tool-test-'),
    );
    expect(toolBriefs[0].slug).toBe('toolchain-tool-test-local-write-file');
  });

  it('generated tool-test briefs pass validateBrief', async () => {
    writeToolTest('my-tool');
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { proposals: Array<unknown> };
    for (const brief of ev.proposals.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p: any) => p.template === 'subprocess_health_probe' && (p.slug as string).startsWith('toolchain-tool-test-'),
    )) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(validateBrief(brief as any)).toBeNull();
    }
  });

  it('intervene writes a self_findings row for each tool-test brief', async () => {
    writeToolTest('my-tool');
    const env = buildDb({
      // pre-fill all three toolchain slugs so the only new proposal is the tool-test one
      existing_proposals: [
        { id: '1', experiment_id: 'experiment-proposal-generator', category: 'experiment_proposal', subject: 'proposal:toolchain-typecheck', ran_at: new Date().toISOString() },
        { id: '2', experiment_id: 'experiment-proposal-generator', category: 'experiment_proposal', subject: 'proposal:toolchain-lint', ran_at: new Date().toISOString() },
        { id: '3', experiment_id: 'experiment-proposal-generator', category: 'experiment_proposal', subject: 'proposal:toolchain-tests', ran_at: new Date().toISOString() },
      ],
    });
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('pass', result, ctx);
    expect(intervention).not.toBeNull();
    const rows = env.tables.self_findings.filter(
      (r) => r.category === 'experiment_proposal',
    );
    const toolRow = rows.find((r) =>
      String(r.subject ?? '').includes('toolchain-tool-test-my-tool'),
    );
    expect(toolRow).toBeDefined();
    const evidence = JSON.parse(toolRow!.evidence as string);
    expect(evidence.brief.template).toBe('subprocess_health_probe');
    expect(evidence.brief.params.command).toContain('my-tool.test.ts');
  });

  it('judge returns warning only when all data sources have nothing', async () => {
    // Null repo root (no migrations, no tools), no llm_calls, all
    // toolchain slugs already in the ledger.
    setSelfCommitRepoRoot(null);
    const env = buildDb({
      existing_proposals: [
        { id: '1', experiment_id: 'x', category: 'experiment_proposal', subject: 'proposal:toolchain-typecheck', ran_at: new Date().toISOString() },
        { id: '2', experiment_id: 'x', category: 'experiment_proposal', subject: 'proposal:toolchain-lint', ran_at: new Date().toISOString() },
        { id: '3', experiment_id: 'x', category: 'experiment_proposal', subject: 'proposal:toolchain-tests', ran_at: new Date().toISOString() },
      ],
    });
    const result = await exp.probe(makeCtx(env));
    expect(exp.judge(result, [])).toBe('warning');
  });
});
