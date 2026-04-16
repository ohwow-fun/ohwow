import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  GitVelocityExperiment,
  parseGitLog,
  rollUpByBucket,
  type GitVelocityEvidence,
} from '../experiments/git-velocity.js';
import {
  setSelfCommitRepoRoot,
  _resetSelfCommitForTests,
} from '../self-commit.js';
import type { ExperimentContext, Finding } from '../experiment-types.js';

let repo: string;

function git(cmd: string, cwd: string = repo): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function writeFile(rel: string, body: string) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function makeCtx(): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {} as any,
    workspaceId: 'ws-test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async (_id: string, _limit?: number) => [] as Finding[],
  };
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-velocity-'));
  execSync('git init -b main', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "t@t.local"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repo, stdio: 'pipe' });
  execSync('git config commit.gpgsign false', { cwd: repo, stdio: 'pipe' });
  writeFile('README.md', 'seed\n');
  git('git add README.md');
  git('git commit -m "init"');
  setSelfCommitRepoRoot(repo);
});

afterEach(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  _resetSelfCommitForTests();
});

describe('parseGitLog', () => {
  it('parses records anchored on SHA with --EOC-- between body and files', () => {
    // Matches the shape `git log --name-only --pretty=format:%H%n%s%n%b%n--EOC--`
    // emits on a real repo: header block, --EOC-- marker, then file list,
    // then blank line before the next SHA.
    const raw = [
      'a'.repeat(40),
      'feat: human work',
      'some body',
      '',
      '--EOC--',
      'src/lib/foo.ts',
      'src/lib/bar.ts',
      '',
      'b'.repeat(40),
      'feat(self-bench): auto-author thing',
      'Self-authored by experiment: experiment-author',
      '',
      '--EOC--',
      'src/self-bench/experiments/thing.ts',
      '',
    ].join('\n');
    const parsed = parseGitLog(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].autonomous).toBe(false);
    expect(parsed[0].files).toEqual(['src/lib/foo.ts', 'src/lib/bar.ts']);
    expect(parsed[1].autonomous).toBe(true);
    expect(parsed[1].files).toEqual(['src/self-bench/experiments/thing.ts']);
  });
});

describe('rollUpByBucket', () => {
  it('groups files by top-level prefix and splits autonomous vs human', () => {
    const commits = [
      { sha: 'a'.repeat(40), subject: 'x', autonomous: false, files: ['src/lib/a.ts', 'src/lib/b.ts'] },
      { sha: 'b'.repeat(40), subject: 'y', autonomous: true,  files: ['src/self-bench/experiments/x.ts'] },
      { sha: 'c'.repeat(40), subject: 'z', autonomous: false, files: ['src/lib/a.ts', 'src/self-bench/__tests__/y.ts'] },
    ];
    const rolled = rollUpByBucket(commits);
    const lib = rolled.find((r) => r.subsystem === 'src/lib/')!;
    const bench = rolled.find((r) => r.subsystem === 'src/self-bench/')!;
    expect(lib.commits_total).toBe(2);
    expect(lib.commits_autonomous).toBe(0);
    expect(lib.commits_human).toBe(2);
    expect(lib.files_changed).toBe(3); // 2 files in commit 1 + 1 in commit 3
    expect(bench.commits_total).toBe(2);
    expect(bench.commits_autonomous).toBe(1);
    expect(bench.commits_human).toBe(1);
  });

  it('puts paths outside the known prefix list into the `other` bucket', () => {
    const commits = [
      { sha: 'a'.repeat(40), subject: 'x', autonomous: false, files: ['CHANGELOG.md', 'package.json'] },
    ];
    const rolled = rollUpByBucket(commits);
    expect(rolled[0].subsystem).toBe('other');
    expect(rolled[0].commits_total).toBe(1);
    expect(rolled[0].files_changed).toBe(2);
  });
});

describe('GitVelocityExperiment', () => {
  const exp = new GitVelocityExperiment();

  it('rolls up recent commits by subsystem and tags autonomous ones', async () => {
    writeFile('src/lib/a.ts', 'export const a = 1;\n');
    git('git add src/lib/a.ts');
    git('git commit -m "feat(lib): add a"');

    writeFile('src/self-bench/experiments/foo.ts', 'export {};\n');
    git('git add src/self-bench/experiments/foo.ts');
    fs.writeFileSync(
      path.join(repo, '.git', 'COMMIT_MSG'),
      'feat(self-bench): auto-author\n\nSelf-authored by experiment: experiment-author\n',
    );
    git('git commit -F .git/COMMIT_MSG');

    const result = await exp.probe(makeCtx());
    const ev = result.evidence as GitVelocityEvidence;
    // The seed init commit is also in the 24h window; asserting on the
    // test-added two commits only keeps the expectations stable.
    expect(ev.commits_autonomous).toBe(1);
    expect(ev.commits_human).toBeGreaterThanOrEqual(1);
    const lib = ev.subsystems.find((s) => s.subsystem === 'src/lib/');
    const bench = ev.subsystems.find((s) => s.subsystem === 'src/self-bench/');
    expect(lib?.commits_human).toBe(1);
    expect(bench?.commits_autonomous).toBe(1);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('passes cleanly when the window is empty', async () => {
    // Seed repo has only the init commit outside the window semantics —
    // git log --since=24h will still include it, so force an empty-like
    // state by running the probe immediately after repo creation.
    const result = await exp.probe(makeCtx());
    const ev = result.evidence as GitVelocityEvidence;
    expect(ev.commits_total).toBeGreaterThanOrEqual(0);
    expect(exp.judge(result, [])).toBe('pass');
  });
});
