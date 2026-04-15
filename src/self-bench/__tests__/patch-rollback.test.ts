import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  findAutonomousPatchesInWindow,
  normalizeCommitTsToUtc,
  revertCommit,
} from '../patch-rollback.js';

let repo: string;
let origin: string;

function git(cmd: string, cwd: string = repo): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function seedCommit(
  relPath: string,
  content: string,
  message: string,
): string {
  const abs = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  git(`git add ${relPath}`);
  // Write message via a temp file so multi-line bodies (with trailers) survive.
  const msgFile = path.join(repo, '.git', 'COMMIT_MSG');
  fs.writeFileSync(msgFile, message, 'utf-8');
  git(`git commit -F "${msgFile}"`);
  return git('git rev-parse HEAD').trim();
}

beforeEach(() => {
  origin = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-revert-origin-'));
  execSync('git init --bare -b main', { cwd: origin, stdio: 'pipe' });

  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-revert-repo-'));
  execSync('git init -b main', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "t@t.local"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repo, stdio: 'pipe' });
  execSync('git config commit.gpgsign false', { cwd: repo, stdio: 'pipe' });
  execSync(`git remote add origin "${origin}"`, { cwd: repo, stdio: 'pipe' });
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git('git add README.md');
  git('git commit -m "init"');
  git('git push -u origin main');

  process.env.OHWOW_AUTO_REVERT_TEST_ALLOW = '1';
});

afterEach(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(origin, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.OHWOW_AUTO_REVERT_TEST_ALLOW;
});

describe('findAutonomousPatchesInWindow', () => {
  it('returns [] when no autonomous commits are in the window', () => {
    seedCommit('a.ts', 'export const a = 1;\n', 'chore: hand-written commit');
    expect(findAutonomousPatchesInWindow(repo, 60_000)).toEqual([]);
  });

  it('returns only commits that carry a Fixes-Finding-Id trailer', () => {
    seedCommit(
      'a.ts',
      'export const a = 1;\n',
      'feat(self-bench): autonomous greenfield probe author\n\nSelf-authored by experiment: author-x\n',
    );
    const patchSha = seedCommit(
      'b.ts',
      'export const b = 2;\n',
      'feat(self-bench): autonomous fix\n\nSelf-authored by experiment: patcher-x\n\nFixes-Finding-Id: aaaaaaaa-1111-2222-3333-444444444444\n',
    );

    const patches = findAutonomousPatchesInWindow(repo, 60_000);
    expect(patches).toHaveLength(1);
    expect(patches[0].sha).toBe(patchSha);
    expect(patches[0].findingId).toBe('aaaaaaaa-1111-2222-3333-444444444444');
    expect(patches[0].experimentId).toBe('patcher-x');
    expect(patches[0].files).toEqual(['b.ts']);
  });

  it('emits patch.ts in UTC Z-form regardless of committer local offset', () => {
    // Simulate a committer in Chicago (UTC-5) making an autonomous patch.
    // git %aI would emit e.g. 2026-04-14T21:26:01-05:00 — lexicographically
    // greater than a UTC finding at the same UTC time. The normalization
    // inside findAutonomousPatchesInWindow must strip the offset so
    // downstream string compares against ran_at (stored as …Z) work.
    const abs = path.join(repo, 'x.ts');
    fs.writeFileSync(abs, 'export const x = 1;\n');
    git('git add x.ts');
    const msgFile = path.join(repo, '.git', 'COMMIT_MSG');
    fs.writeFileSync(
      msgFile,
      'feat(self-bench): tz-skewed autonomous patch\n\nFixes-Finding-Id: bbbbbbbb-cccc-dddd-eeee-ffffffffffff\n',
    );
    execSync(`git commit -F "${msgFile}"`, {
      cwd: repo,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-04-14T21:26:01-05:00',
        GIT_COMMITTER_DATE: '2026-04-14T21:26:01-05:00',
      },
    });
    const patches = findAutonomousPatchesInWindow(repo, 24 * 60 * 60_000);
    expect(patches).toHaveLength(1);
    expect(patches[0].ts).toBe('2026-04-15T02:26:01.000Z');
    // And a ran_at in the pre-patch gap must NOT be > patch.ts:
    expect('2026-04-15T02:05:13Z' > patches[0].ts).toBe(false);
  });

  it('excludes commits older than the window', () => {
    const abs = path.join(repo, 'a.ts');
    fs.writeFileSync(abs, 'export const a = 1;\n');
    git('git add a.ts');
    const msgFile = path.join(repo, '.git', 'COMMIT_MSG');
    fs.writeFileSync(
      msgFile,
      'feat(self-bench): old patch\n\nFixes-Finding-Id: deadbeef-0000-0000-0000-000000000000\n',
    );
    // Backdate via both GIT_AUTHOR_DATE + GIT_COMMITTER_DATE so git log --since respects it.
    execSync(`git commit -F "${msgFile}"`, {
      cwd: repo,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: new Date(Date.now() - 60 * 60_000).toISOString(),
        GIT_COMMITTER_DATE: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
    });
    // Window of 5 minutes — the hour-old commit should be filtered out.
    expect(findAutonomousPatchesInWindow(repo, 5 * 60_000)).toEqual([]);
  });
});

describe('normalizeCommitTsToUtc', () => {
  it('strips a local offset into Z-form', () => {
    expect(normalizeCommitTsToUtc('2026-04-14T21:26:01-05:00')).toBe('2026-04-15T02:26:01.000Z');
    expect(normalizeCommitTsToUtc('2026-04-15T02:26:01Z')).toBe('2026-04-15T02:26:01.000Z');
    expect(normalizeCommitTsToUtc('2026-04-15T04:26:01+02:00')).toBe('2026-04-15T02:26:01.000Z');
  });

  it('throws on unparseable input', () => {
    expect(() => normalizeCommitTsToUtc('not-a-date')).toThrow();
  });
});

describe('revertCommit', () => {
  it('refuses when the kill switch is closed', () => {
    delete process.env.OHWOW_AUTO_REVERT_TEST_ALLOW;
    const sha = seedCommit(
      'a.ts',
      'export const a = 1;\n',
      'feat(self-bench): patch to revert\n\nFixes-Finding-Id: aaaa\n',
    );
    const r = revertCommit(repo, sha, 'post-patch finding re-fired with verdict=fail');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('disabled by default');
  });

  it('refuses an invalid sha', () => {
    const r = revertCommit(repo, 'not-a-sha', 'test reason long enough');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('invalid sha');
  });

  it('refuses a too-short reason', () => {
    const sha = seedCommit('a.ts', 'export const a = 1;\n', 'feat: a');
    const r = revertCommit(repo, sha, 'short');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('at least 10');
  });

  it('reverts a commit, amends the message with an Auto-Reverts trailer, and pushes', () => {
    const sha = seedCommit(
      'bad.ts',
      'export const bad = 1;\n',
      'feat(self-bench): bad patch\n\nFixes-Finding-Id: ffffaaaa\n',
    );
    const r = revertCommit(repo, sha, 'finding re-fired verdict=fail inside cool-off');
    expect(r.ok).toBe(true);
    expect(r.revertSha).toBeTruthy();
    expect(r.revertSha).not.toBe(sha);

    const msg = execSync('git log -1 --pretty=%B', { cwd: repo, encoding: 'utf-8' });
    expect(msg).toContain(`Auto-Reverts: ${sha}`);
    expect(msg).toContain('finding re-fired verdict=fail');

    // The reverted file is gone from the working tree.
    expect(fs.existsSync(path.join(repo, 'bad.ts'))).toBe(false);

    // Push landed — origin's HEAD matches local HEAD.
    const localHead = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
    const originHead = execSync('git rev-parse main', { cwd: origin, encoding: 'utf-8' }).trim();
    expect(originHead).toBe(localHead);
  });
});
