import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { AutonomousPatchRollbackExperiment } from '../experiments/autonomous-patch-rollback.js';
import {
  setSelfCommitRepoRoot,
  _resetSelfCommitForTests,
} from '../self-commit.js';
import type { ExperimentContext } from '../experiment-types.js';

/**
 * The experiment composes two already-tested primitives
 * (findAutonomousPatchesInWindow + revertCommit) plus a db lookup. The
 * primitives have their own tests in patch-rollback.test.ts; here we
 * verify probe + judge against a real temp git repo with stubbed db
 * responses, so the wiring itself doesn't regress.
 */

let repo: string;

function git(cmd: string): string {
  return execSync(cmd, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function seedPatchCommit(findingId: string): string {
  fs.writeFileSync(path.join(repo, 'bad.ts'), 'export const bad = 1;\n');
  git('git add bad.ts');
  const msgFile = path.join(repo, '.git', 'COMMIT_MSG');
  fs.writeFileSync(
    msgFile,
    `feat(self-bench): autonomous patch\n\nSelf-authored by experiment: patcher-x\n\nFixes-Finding-Id: ${findingId}\n`,
  );
  git(`git commit -F "${msgFile}"`);
  return git('git rev-parse HEAD').trim();
}

function stubDb(responses: { original?: unknown[]; refire?: unknown[] }) {
  // Route on the first `eq` column: id → original; experiment_id → refire.
  type Resp = Promise<{ data: unknown[]; error: null }>;
  const makeChain = (rows: unknown[]): { select: () => unknown; eq: () => unknown; gt: () => unknown; limit: () => Resp } => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      gt: () => chain,
      limit: (): Resp => Promise.resolve({ data: rows, error: null }),
    };
    return chain;
  };
  return {
    from: () => {
      const chain = {
        select: () => chain,
        eq: (col: string) => {
          if (col === 'id') return makeChain(responses.original ?? []);
          if (col === 'experiment_id') return makeChain(responses.refire ?? []);
          return chain;
        },
        gt: () => chain,
        limit: (): Resp => Promise.resolve({ data: [], error: null }),
      };
      return chain;
    },
  };
}

function makeCtx(db: unknown): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: db as any,
    workspaceId: 'ws-test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async () => [],
  };
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-rollback-exp-'));
  execSync('git init -b main', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "t@t.local"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repo, stdio: 'pipe' });
  execSync('git config commit.gpgsign false', { cwd: repo, stdio: 'pipe' });
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git('git add README.md');
  git('git commit -m "init"');
  setSelfCommitRepoRoot(repo);
});

afterEach(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  _resetSelfCommitForTests();
});

describe('AutonomousPatchRollbackExperiment.probe', () => {
  it('returns zero candidates when no autonomous commits exist', async () => {
    const exp = new AutonomousPatchRollbackExperiment();
    const result = await exp.probe(makeCtx(stubDb({})));
    expect((result.evidence as { patches_in_window: number }).patches_in_window).toBe(0);
    expect((result.evidence as { candidates: unknown[] }).candidates).toEqual([]);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('flags a patch whose justifying finding re-fires with verdict=fail', async () => {
    const findingId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const sha = seedPatchCommit(findingId);

    const db = stubDb({
      original: [{ id: findingId, experiment_id: 'probe-x', subject: 'loop:goal-1', ran_at: '2026-04-13T00:00:00Z' }],
      refire: [{ id: 'refire-1', verdict: 'fail', ran_at: '2026-04-14T18:00:00Z', evidence: { affected_files: ['bad.ts'] } }],
    });
    const exp = new AutonomousPatchRollbackExperiment();
    const result = await exp.probe(makeCtx(db));

    const ev = result.evidence as { candidates: Array<{ sha: string; refireVerdict: string }> };
    expect(ev.candidates).toHaveLength(1);
    expect(ev.candidates[0].sha).toBe(sha);
    expect(ev.candidates[0].refireVerdict).toBe('fail');
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('does NOT flag a patch whose original finding has no post-commit re-fire', async () => {
    seedPatchCommit('bbbbbbbb-0000-0000-0000-000000000000');

    const db = stubDb({
      original: [{ id: 'bbbbbbbb-0000-0000-0000-000000000000', experiment_id: 'probe-y', subject: null, ran_at: '2026-04-13T00:00:00Z' }],
      refire: [], // nothing re-fired
    });
    const exp = new AutonomousPatchRollbackExperiment();
    const result = await exp.probe(makeCtx(db));

    const ev = result.evidence as { candidates: unknown[] };
    expect(ev.candidates).toEqual([]);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('does NOT flag a patch when the refire affects a DIFFERENT file', async () => {
    // Regression guard: the patch edited bad.ts; a subsequent
    // source-copy-lint-shaped warning lists only 'other.ts' in
    // affected_files. Old logic reverted on same experiment+subject
    // regardless of which file refired; new logic requires overlap.
    const findingId = 'dddddddd-0000-0000-0000-000000000000';
    seedPatchCommit(findingId);
    const db = stubDb({
      original: [{ id: findingId, experiment_id: 'source-copy-lint', subject: 'meta:source-copy-lint', ran_at: '2026-04-13T00:00:00Z' }],
      refire: [{
        id: 'refire-other',
        verdict: 'warning',
        ran_at: '2026-04-14T18:00:00Z',
        evidence: { affected_files: ['src/web/src/pages/Other.tsx'] },
      }],
    });
    const exp = new AutonomousPatchRollbackExperiment();
    const result = await exp.probe(makeCtx(db));
    expect((result.evidence as { candidates: unknown[] }).candidates).toEqual([]);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('flags a patch when refire affected_files INTERSECT the patched files', async () => {
    const findingId = 'eeeeeeee-0000-0000-0000-000000000000';
    seedPatchCommit(findingId); // touches bad.ts
    const db = stubDb({
      original: [{ id: findingId, experiment_id: 'source-copy-lint', subject: 'meta:source-copy-lint', ran_at: '2026-04-13T00:00:00Z' }],
      refire: [{
        id: 'refire-overlap',
        verdict: 'warning',
        ran_at: '2026-04-14T18:00:00Z',
        evidence: { affected_files: ['bad.ts', 'some/other.ts'] },
      }],
    });
    const exp = new AutonomousPatchRollbackExperiment();
    const result = await exp.probe(makeCtx(db));
    expect((result.evidence as { candidates: unknown[] }).candidates).toHaveLength(1);
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('falls back to experiment+subject match when refire has no affected_files', async () => {
    // Experiments that don't populate affected_files still benefit
    // from the reverter — we'd rather over-revert for them than
    // silently disable the gate.
    const findingId = 'ffffffff-0000-0000-0000-000000000000';
    seedPatchCommit(findingId);
    const db = stubDb({
      original: [{ id: findingId, experiment_id: 'probe-legacy', subject: 'loop:goal-legacy', ran_at: '2026-04-13T00:00:00Z' }],
      refire: [{ id: 'refire-legacy', verdict: 'fail', ran_at: '2026-04-14T18:00:00Z', evidence: {} }],
    });
    const exp = new AutonomousPatchRollbackExperiment();
    const result = await exp.probe(makeCtx(db));
    expect((result.evidence as { candidates: unknown[] }).candidates).toHaveLength(1);
  });

  it('ignores a patch whose original finding no longer exists in the ledger', async () => {
    seedPatchCommit('cccccccc-0000-0000-0000-000000000000');

    const db = stubDb({ original: [], refire: [] });
    const exp = new AutonomousPatchRollbackExperiment();
    const result = await exp.probe(makeCtx(db));

    const ev = result.evidence as { candidates: unknown[]; patches_in_window: number };
    expect(ev.patches_in_window).toBe(1);
    expect(ev.candidates).toEqual([]);
  });
});

describe('AutonomousPatchRollbackExperiment.intervene', () => {
  it('returns null when no candidates are flagged', async () => {
    const exp = new AutonomousPatchRollbackExperiment();
    const result = await exp.probe(makeCtx(stubDb({})));
    const intervention = await exp.intervene(exp.judge(result, []), result, makeCtx(stubDb({})));
    expect(intervention).toBeNull();
  });
});
