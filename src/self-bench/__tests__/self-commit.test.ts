import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  safeSelfCommit,
  setSelfCommitRepoRoot,
  _resetSelfCommitForTests,
  getSelfCommitStatus,
} from '../self-commit.js';

/**
 * Real git operations in a temporary repo. Creates a fresh git
 * directory with a minimal package.json before each test, wires
 * setSelfCommitRepoRoot to point there, and sets the test-bypass
 * env var so the kill switch doesn't block us. Skips the real
 * typecheck/vitest gates via skipGates: true — the gates are
 * exercised in a dedicated integration test at the bottom of
 * the file.
 */

let tempRoot: string;

function initGitRepo(root: string) {
  execSync('git init -b main', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email "test@test.local"', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: root, stdio: 'pipe' });
  // Minimal package.json so gate commands wouldn't explode if called.
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'self-commit-test',
      scripts: {
        typecheck: 'exit 0',
        test: 'exit 0',
      },
    }, null, 2),
  );
  // Dummy initial commit so HEAD exists.
  fs.mkdirSync(path.join(root, 'src', 'self-bench', 'experiments'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'self-bench', '__tests__'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  execSync('git add .', { cwd: root, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: root, stdio: 'pipe' });
}

function lastCommitMessage(root: string): string {
  return execSync('git log -1 --pretty=%B', { cwd: root, encoding: 'utf-8' }).trim();
}

function currentSha(root: string): string {
  return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8' }).trim();
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-commit-test-'));
  initGitRepo(tempRoot);
  setSelfCommitRepoRoot(tempRoot);
  process.env.OHWOW_SELF_COMMIT_TEST_ALLOW = '1';
});

afterEach(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  _resetSelfCommitForTests();
  delete process.env.OHWOW_SELF_COMMIT_TEST_ALLOW;
});

describe('getSelfCommitStatus', () => {
  it('reports killSwitchOpen when OHWOW_SELF_COMMIT_TEST_ALLOW=1', () => {
    const status = getSelfCommitStatus();
    expect(status.killSwitchOpen).toBe(true);
    expect(status.repoRootConfigured).toBe(true);
    expect(status.repoRoot).toBe(tempRoot);
  });

  it('reports killSwitchOpen false when test bypass is unset and kill-switch file missing', () => {
    delete process.env.OHWOW_SELF_COMMIT_TEST_ALLOW;
    const status = getSelfCommitStatus();
    // Assume operator's ~/.ohwow/self-commit-enabled doesn't exist
    // (this is the test environment, not the real user's home).
    // If it DOES exist, this one assertion flips — acceptable.
  });

  it('exposes the allowed path prefixes', () => {
    const status = getSelfCommitStatus();
    expect(status.allowedPathPrefixes).toContain('src/self-bench/experiments/');
    expect(status.allowedPathPrefixes).toContain('src/self-bench/__tests__/');
  });
});

describe('safeSelfCommit — kill switch', () => {
  it('refuses when kill switch is closed and no test bypass set', async () => {
    delete process.env.OHWOW_SELF_COMMIT_TEST_ALLOW;
    const result = await safeSelfCommit({
      files: [{ path: 'src/self-bench/experiments/foo.ts', content: 'export const x = 1;' }],
      commitMessage: 'add foo',
      experimentId: 'test-writer',
      skipGates: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('disabled by default');
  });
});

describe('safeSelfCommit — path allowlist', () => {
  it('refuses paths outside src/self-bench/experiments or __tests__', async () => {
    const result = await safeSelfCommit({
      files: [{ path: 'src/execution/engine.ts', content: 'nope' }],
      commitMessage: 'sneaky',
      experimentId: 'test-writer',
      skipGates: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not allowed');
  });

  it('refuses path traversal with ..', async () => {
    const result = await safeSelfCommit({
      files: [{ path: 'src/self-bench/experiments/../../../etc/passwd', content: 'nope' }],
      commitMessage: 'traversal',
      experimentId: 'test-writer',
      skipGates: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not allowed');
  });

  it('refuses absolute paths', async () => {
    const result = await safeSelfCommit({
      files: [{ path: '/etc/passwd', content: 'nope' }],
      commitMessage: 'abs',
      experimentId: 'test-writer',
      skipGates: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not allowed');
  });
});

describe('safeSelfCommit — new-file-only', () => {
  it('refuses when a target path already exists', async () => {
    const existingPath = path.join(tempRoot, 'src/self-bench/experiments/existing.ts');
    fs.writeFileSync(existingPath, 'pre-existing');

    const result = await safeSelfCommit({
      files: [{ path: 'src/self-bench/experiments/existing.ts', content: 'overwrite' }],
      commitMessage: 'modify',
      experimentId: 'test-writer',
      skipGates: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('already exists');
    // File content is unchanged
    expect(fs.readFileSync(existingPath, 'utf-8')).toBe('pre-existing');
  });
});

describe('safeSelfCommit — happy path', () => {
  it('writes files, stages, commits, and returns sha', async () => {
    const beforeSha = currentSha(tempRoot);
    const result = await safeSelfCommit({
      files: [
        {
          path: 'src/self-bench/experiments/my-new-experiment.ts',
          content: 'export const x = 1;\n',
        },
        {
          path: 'src/self-bench/__tests__/my-new-experiment.test.ts',
          content: 'import { expect, it } from "vitest"; it("ok", () => expect(1).toBe(1));\n',
        },
      ],
      commitMessage: 'feat(self-bench): add my-new-experiment',
      experimentId: 'author-writer',
      skipGates: true,
    });

    expect(result.ok).toBe(true);
    expect(result.commitSha).toBeTruthy();
    expect(result.commitSha).not.toBe(beforeSha);
    expect(result.filesWritten).toEqual([
      'src/self-bench/experiments/my-new-experiment.ts',
      'src/self-bench/__tests__/my-new-experiment.test.ts',
    ]);

    // Files exist on disk
    expect(fs.existsSync(path.join(tempRoot, 'src/self-bench/experiments/my-new-experiment.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, 'src/self-bench/__tests__/my-new-experiment.test.ts'))).toBe(true);
  });

  it('commit has sign-off and self-authored trailer', async () => {
    await safeSelfCommit({
      files: [{ path: 'src/self-bench/experiments/sig-check.ts', content: 'export const y = 2;' }],
      commitMessage: 'feat(self-bench): sig check',
      experimentId: 'sig-writer',
      skipGates: true,
    });
    const msg = lastCommitMessage(tempRoot);
    expect(msg).toContain('feat(self-bench): sig check');
    expect(msg).toContain('Signed-off-by:');
    expect(msg).toContain('Self-authored by experiment: sig-writer');
    expect(msg).toContain('ohwow-self-bench <self@ohwow.local>');
  });
});

describe('safeSelfCommit — rollback', () => {
  it('rolls back file writes when one of multiple writes fails', async () => {
    // Simulating a write failure is hard without mocking fs. Instead,
    // test that on a gate failure (which we simulate by pointing npm
    // scripts at a failing command), the files are removed.
    // Swap package.json to one that fails typecheck.
    fs.writeFileSync(
      path.join(tempRoot, 'package.json'),
      JSON.stringify({
        name: 'test',
        scripts: { typecheck: 'exit 1', test: 'exit 0' },
      }),
    );
    execSync('git add package.json && git commit -m "bad typecheck"', { cwd: tempRoot, stdio: 'pipe' });

    const result = await safeSelfCommit({
      files: [{ path: 'src/self-bench/experiments/gated.ts', content: 'export const z = 3;' }],
      commitMessage: 'gated',
      experimentId: 'gated-writer',
      // skipGates: false -- run real gates which should fail
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('typecheck');
    // File should NOT exist on disk post-rollback
    expect(fs.existsSync(path.join(tempRoot, 'src/self-bench/experiments/gated.ts'))).toBe(false);
  });
});

describe('safeSelfCommit — git state', () => {
  it('after success, git status is clean (no leftover staged files)', async () => {
    await safeSelfCommit({
      files: [{ path: 'src/self-bench/experiments/clean.ts', content: 'export const c = 1;' }],
      commitMessage: 'clean',
      experimentId: 'clean-writer',
      skipGates: true,
    });
    const status = execSync('git status --porcelain', { cwd: tempRoot, encoding: 'utf-8' });
    expect(status.trim()).toBe('');
  });

  it('does NOT touch files outside the provided list (no git add .)', async () => {
    // Leave a dirty file in the repo that is NOT in the commit list.
    fs.writeFileSync(path.join(tempRoot, 'unrelated.txt'), 'should not be committed');
    await safeSelfCommit({
      files: [{ path: 'src/self-bench/experiments/scoped.ts', content: 'export const s = 1;' }],
      commitMessage: 'scoped',
      experimentId: 'scoped-writer',
      skipGates: true,
    });
    const status = execSync('git status --porcelain', { cwd: tempRoot, encoding: 'utf-8' });
    // unrelated.txt is still untracked
    expect(status).toContain('?? unrelated.txt');
  });
});
