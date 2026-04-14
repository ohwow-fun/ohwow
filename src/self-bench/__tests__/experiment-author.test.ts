import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ExperimentAuthorExperiment } from '../experiments/experiment-author.js';
import {
  setSelfCommitRepoRoot,
  _resetSelfCommitForTests,
} from '../self-commit.js';
import type {
  Experiment,
  ExperimentContext,
  Finding,
  ExperimentCategory,
  Verdict,
} from '../experiment-types.js';
import type { ExperimentBrief } from '../experiment-template.js';

/**
 * The author experiment tests use a real temporary git repo so
 * safeSelfCommit's write + git sequence runs against actual
 * commands. The probe/judge/intervene pipeline runs as the runner
 * would invoke it, with ctx.recentFindings returning canned
 * proposal rows.
 *
 * skipGates is the knob we can't use here because the author
 * experiment calls safeSelfCommit WITHOUT it — production code
 * must run the real gates. For the temp repo we bypass gates by
 * pointing npm scripts at no-ops in the temp package.json.
 */

let tempRoot: string;

function initRepo(root: string) {
  execSync('git init -b main', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email "test@test.local"', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'author-test',
      scripts: { typecheck: 'exit 0', test: 'exit 0' },
    }),
  );
  fs.mkdirSync(path.join(root, 'src/self-bench/experiments'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/self-bench/__tests__'), { recursive: true });
  // Create a stub vitest binary via node_modules/.bin so the
  // `npx vitest run <testfile>` from safeSelfCommit's gate passes.
  fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
  const vitestStub = '#!/bin/sh\nexit 0\n';
  const vitestPath = path.join(root, 'node_modules/.bin/vitest');
  fs.writeFileSync(vitestPath, vitestStub);
  fs.chmodSync(vitestPath, 0o755);
  execSync('git add .', { cwd: root, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: root, stdio: 'pipe' });
}

const sampleBrief: ExperimentBrief = {
  slug: 'author-test-probe',
  name: 'Author test probe',
  hypothesis: 'the author pipeline produces committable code',
  everyMs: 30 * 60 * 1000,
  template: 'model_latency_probe',
  params: {
    model_id: 'vendor/test-model',
    sample_size: 50,
    warn_latency_ms: 1000,
    fail_latency_ms: 3000,
    min_samples: 10,
  },
};

function proposalFinding(brief: ExperimentBrief, claimed = false, ranAt?: string): Finding {
  return {
    id: 'f-' + Math.random().toString(36).slice(2, 10),
    experimentId: 'experiment-proposal-generator',
    category: 'experiment_proposal' as ExperimentCategory,
    subject: `proposal:${brief.slug}`,
    hypothesis: null,
    verdict: 'warning',
    summary: `proposal for ${brief.slug}`,
    evidence: {
      is_experiment_proposal: true,
      brief,
      claimed,
    },
    interventionApplied: null,
    ranAt: ranAt ?? new Date().toISOString(),
    durationMs: 0,
    status: 'active',
    supersededBy: null,
    createdAt: ranAt ?? new Date().toISOString(),
  };
}

function makeCtx(
  tempRoot: string,
  historyByExperiment: Record<string, Finding[]>,
  insertedFindings: Array<Record<string, unknown>> = [],
): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {
      from: vi.fn().mockImplementation(() => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.gte = () => chain;
        chain.lt = () => chain;
        chain.order = () => chain;
        chain.limit = () => Promise.resolve({ data: [], error: null });
        chain.insert = (row: Record<string, unknown>) => {
          insertedFindings.push({ ...row });
          return Promise.resolve({ data: null, error: null });
        };
        chain.then = (resolve: (v: unknown) => void) =>
          resolve({ data: [], error: null });
        return chain;
      }),
    } as any,
    workspaceId: 'ws-test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async (experimentId: string) =>
      historyByExperiment[experimentId] ?? [],
  };
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'author-test-'));
  initRepo(tempRoot);
  setSelfCommitRepoRoot(tempRoot);
  process.env.OHWOW_SELF_COMMIT_TEST_ALLOW = '1';
});

afterEach(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  _resetSelfCommitForTests();
  delete process.env.OHWOW_SELF_COMMIT_TEST_ALLOW;
});

describe('ExperimentAuthorExperiment — probe', () => {
  const exp: Experiment = new ExperimentAuthorExperiment();

  it('reports no unclaimed when ledger is empty', async () => {
    const ctx = makeCtx(tempRoot, {});
    const result = await exp.probe(ctx);
    const ev = result.evidence as { unclaimed_count: number; selected_brief: unknown };
    expect(ev.unclaimed_count).toBe(0);
    expect(ev.selected_brief).toBeNull();
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('picks an unclaimed proposal when one exists', async () => {
    const ctx = makeCtx(tempRoot, {
      'experiment-proposal-generator': [proposalFinding(sampleBrief, false)],
    });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { unclaimed_count: number; selected_brief: { slug: string } };
    expect(ev.unclaimed_count).toBe(1);
    expect(ev.selected_brief.slug).toBe('author-test-probe');
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('skips already-claimed proposals', async () => {
    const ctx = makeCtx(tempRoot, {
      'experiment-proposal-generator': [proposalFinding(sampleBrief, false, '2026-04-14T10:00:00Z')],
      'experiment-author': [proposalFinding(sampleBrief, true, '2026-04-14T11:00:00Z')],
    });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { unclaimed_count: number };
    expect(ev.unclaimed_count).toBe(0);
  });

  it('picks the oldest proposal FIFO when multiple are unclaimed', async () => {
    const older = proposalFinding(
      { ...sampleBrief, slug: 'older-proposal' },
      false,
      '2026-04-14T09:00:00Z',
    );
    const newer = proposalFinding(
      { ...sampleBrief, slug: 'newer-proposal' },
      false,
      '2026-04-14T12:00:00Z',
    );
    const ctx = makeCtx(tempRoot, {
      'experiment-proposal-generator': [newer, older],
    });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { selected_brief: { slug: string } };
    expect(ev.selected_brief.slug).toBe('older-proposal');
  });
});

describe('ExperimentAuthorExperiment — intervene', () => {
  const exp: Experiment = new ExperimentAuthorExperiment();

  it('authors a new experiment end-to-end and commits to git', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const ctx = makeCtx(tempRoot, {
      'experiment-proposal-generator': [proposalFinding(sampleBrief, false)],
    }, inserted);

    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('warning', result, ctx);

    expect(intervention).not.toBeNull();
    const details = intervention!.details as {
      commit_ok: boolean;
      commit_sha?: string;
      files_written?: string[];
      brief_slug: string;
    };
    expect(details.commit_ok).toBe(true);
    expect(details.commit_sha).toBeTruthy();
    expect(details.brief_slug).toBe('author-test-probe');
    expect(details.files_written).toEqual([
      'src/self-bench/experiments/author-test-probe.ts',
      'src/self-bench/__tests__/author-test-probe.test.ts',
    ]);

    // Files exist on disk in the temp repo
    expect(fs.existsSync(path.join(tempRoot, 'src/self-bench/experiments/author-test-probe.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, 'src/self-bench/__tests__/author-test-probe.test.ts'))).toBe(true);

    // git log shows the commit
    const log = execSync('git log --oneline', { cwd: tempRoot, encoding: 'utf-8' });
    expect(log).toContain('Author test probe');
    expect(log).toContain('auto-authored');
  });

  it('writes a claim-marker finding after a successful commit', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const ctx = makeCtx(tempRoot, {
      'experiment-proposal-generator': [proposalFinding(sampleBrief, false)],
    }, inserted);

    const result = await exp.probe(ctx);
    await exp.intervene!('warning', result, ctx);

    // The author should have written a claim marker finding.
    const claimRow = inserted.find((r) => r.category === 'experiment_proposal');
    expect(claimRow).toBeDefined();
    const evidence = JSON.parse(claimRow!.evidence as string);
    expect(evidence.claimed).toBe(true);
    expect(evidence.claimed_by).toBe('experiment-author');
    expect(evidence.commit_sha).toBeTruthy();
    expect(evidence.commit_ok).toBe(true);
  });

  it('returns null when no brief was selected', async () => {
    const ctx = makeCtx(tempRoot, {});
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('pass', result, ctx);
    expect(intervention).toBeNull();
  });

  it('refuses to author an invalid brief (defense-in-depth)', async () => {
    const badBrief: ExperimentBrief = {
      ...sampleBrief,
      slug: 'BAD-CASE', // not kebab-case
    };
    const ctx = makeCtx(tempRoot, {
      'experiment-proposal-generator': [proposalFinding(badBrief, false)],
    });
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('warning', result, ctx);
    expect(intervention).not.toBeNull();
    const details = intervention!.details as { validation_error?: string };
    expect(details.validation_error).toBeTruthy();
    // No git commit happened — file should not exist
    expect(fs.existsSync(path.join(tempRoot, 'src/self-bench/experiments/BAD-CASE.ts'))).toBe(false);
  });

  it('records a failure finding when commit fails (kill switch closed)', async () => {
    delete process.env.OHWOW_SELF_COMMIT_TEST_ALLOW;
    const inserted: Array<Record<string, unknown>> = [];
    const ctx = makeCtx(tempRoot, {
      'experiment-proposal-generator': [proposalFinding(sampleBrief, false)],
    }, inserted);

    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('warning', result, ctx);
    const details = intervention!.details as { commit_ok: boolean; commit_reason?: string };
    expect(details.commit_ok).toBe(false);
    expect(details.commit_reason).toContain('disabled by default');

    // Claim marker was written with claimed=false so next run
    // can retry once kill switch is open.
    const markerRow = inserted.find((r) => r.category === 'experiment_proposal');
    const evidence = JSON.parse(markerRow!.evidence as string);
    expect(evidence.claimed).toBe(false);
    expect(evidence.commit_ok).toBe(false);
  });
});
