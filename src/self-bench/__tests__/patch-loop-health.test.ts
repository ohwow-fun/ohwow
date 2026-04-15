import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PatchLoopHealthExperiment } from '../experiments/patch-loop-health.js';
import {
  setSelfCommitRepoRoot,
  _resetSelfCommitForTests,
} from '../self-commit.js';
import type { ExperimentContext } from '../experiment-types.js';

let repo: string;

function git(cmd: string): string {
  return execSync(cmd, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function seedCommit(
  filename: string,
  body: string,
): string {
  fs.writeFileSync(path.join(repo, filename), `export const x = 1;\n`);
  git(`git add ${filename}`);
  const msgFile = path.join(repo, '.git', 'COMMIT_MSG');
  fs.writeFileSync(msgFile, body);
  git(`git commit -F "${msgFile}"`);
  return git('git rev-parse HEAD').trim();
}

function makeCtx(findingsRows: unknown[] = []): ExperimentContext {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    limit: () => Promise.resolve({ data: findingsRows, error: null }),
  };
  const db = { from: () => chain };
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
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-health-'));
  git('git init');
  git('git config user.email test@test.com');
  git('git config user.name Test');
  // Seed a root commit so the log is non-empty.
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  git('git add README.md');
  git('git commit -m "init"');
  _resetSelfCommitForTests();
  setSelfCommitRepoRoot(repo);
});

afterEach(() => {
  _resetSelfCommitForTests();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('PatchLoopHealthExperiment', () => {
  it('returns pass with null hold_rate when no autonomous patches exist', async () => {
    const exp = new PatchLoopHealthExperiment();
    const result = await exp.probe(makeCtx());
    const ev = result.evidence as Record<string, unknown>;
    expect(ev.patches_landed).toBe(0);
    expect(ev.hold_rate).toBeNull();
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('returns pass when all patches held (no reverts)', async () => {
    // Seed one autonomous patch commit.
    seedCommit(
      'a.ts',
      'feat(self-bench): patch a.ts for finding abc12345\n\nFixes-Finding-Id: abc12345-0000-0000-0000-000000000000\nSelf-authored by experiment: patch-author\n',
    );

    const exp = new PatchLoopHealthExperiment();
    const result = await exp.probe(makeCtx());
    const ev = result.evidence as Record<string, unknown>;
    expect(ev.patches_landed).toBe(1);
    expect(ev.patches_reverted).toBe(0);
    expect(ev.hold_rate).toBe(1);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('returns warning when hold_rate is 0.5–0.79', async () => {
    // Two patches, one reverted.
    const sha1 = seedCommit(
      'b.ts',
      'feat(self-bench): patch b.ts for finding bbb\n\nFixes-Finding-Id: bbb00000-0000-0000-0000-000000000000\nSelf-authored by experiment: patch-author\n',
    );
    seedCommit(
      'c.ts',
      'feat(self-bench): patch c.ts for finding ccc\n\nFixes-Finding-Id: ccc00000-0000-0000-0000-000000000000\nSelf-authored by experiment: patch-author\n',
    );
    // Seed revert of sha1.
    seedCommit(
      'd.ts',
      `revert: autonomous patch ${sha1.slice(0, 12)} rolled back by Layer 5\n\nAuto-Reverts: ${sha1}\n`,
    );

    const exp = new PatchLoopHealthExperiment();
    const result = await exp.probe(makeCtx());
    const ev = result.evidence as Record<string, unknown>;
    expect(ev.patches_landed).toBe(2);
    expect(ev.patches_reverted).toBe(1);
    expect(ev.hold_rate).toBe(0.5);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('returns fail when hold_rate < 0.5', async () => {
    // Two patches, both reverted.
    const sha1 = seedCommit(
      'e.ts',
      'feat(self-bench): patch e.ts\n\nFixes-Finding-Id: eee00000-0000-0000-0000-000000000000\n',
    );
    const sha2 = seedCommit(
      'f.ts',
      'feat(self-bench): patch f.ts\n\nFixes-Finding-Id: fff00000-0000-0000-0000-000000000000\n',
    );
    seedCommit(
      'g.ts',
      `revert: patch rolled back\n\nAuto-Reverts: ${sha1}\n`,
    );
    seedCommit(
      'h.ts',
      `revert: patch rolled back\n\nAuto-Reverts: ${sha2}\n`,
    );

    const exp = new PatchLoopHealthExperiment();
    const result = await exp.probe(makeCtx());
    const ev = result.evidence as Record<string, unknown>;
    expect(ev.patches_landed).toBe(2);
    expect(ev.patches_reverted).toBe(2);
    expect(ev.hold_rate).toBe(0);
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('returns warmup pass when runnerStartedAtMs is recent (<30min uptime)', async () => {
    // Seed what would otherwise be a failing signal (2 patches, both
    // reverted → hold_rate=0). With warmup active, verdict must be pass
    // because the pre-restart state can't be distinguished from live.
    const sha1 = seedCommit(
      'warm-a.ts',
      'feat(self-bench): patch\n\nFixes-Finding-Id: aaa00000-0000-0000-0000-000000000000\n',
    );
    const sha2 = seedCommit(
      'warm-b.ts',
      'feat(self-bench): patch\n\nFixes-Finding-Id: bbb00000-0000-0000-0000-000000000000\n',
    );
    seedCommit('warm-c.ts', `revert\n\nAuto-Reverts: ${sha1}\n`);
    seedCommit('warm-d.ts', `revert\n\nAuto-Reverts: ${sha2}\n`);

    const ctx = makeCtx();
    ctx.runnerStartedAtMs = Date.now() - 60_000; // 1min uptime

    const exp = new PatchLoopHealthExperiment();
    const result = await exp.probe(ctx);
    const ev = result.evidence as Record<string, unknown>;
    expect(ev.reason).toBe('post_restart_warmup');
    expect(ev.patches_landed).toBe(0);
    expect(ev.hold_rate).toBeNull();
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('suppresses pool_delta when uptime < 48h', async () => {
    // 31min uptime: past warmup but below 48h, so yesterday comparison
    // is unreliable. pool_delta must be null, summary should say so.
    const ctx = makeCtx();
    ctx.runnerStartedAtMs = Date.now() - 31 * 60 * 1000;
    const exp = new PatchLoopHealthExperiment();
    const result = await exp.probe(ctx);
    const ev = result.evidence as Record<string, unknown>;
    expect(ev.reason).toBeUndefined();
    expect(ev.pool_delta).toBeNull();
    expect(result.summary).toContain('no yesterday comparison');
  });

  it('returns pass with no_repo_root reason when repo root is not configured', async () => {
    _resetSelfCommitForTests();
    // Do not call setSelfCommitRepoRoot — repo root will be null.
    const exp = new PatchLoopHealthExperiment();
    const result = await exp.probe(makeCtx());
    const ev = result.evidence as Record<string, unknown>;
    expect(ev.reason).toBe('no_repo_root');
    expect(exp.judge(result, [])).toBe('pass');
  });
});
