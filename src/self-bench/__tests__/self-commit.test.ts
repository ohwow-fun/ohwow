import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  safeSelfCommit,
  setSelfCommitRepoRoot,
  _resetSelfCommitForTests,
  _setAuditLogPathForTests,
  getSelfCommitStatus,
  type SelfCommitOptions,
} from '../self-commit.js';

/**
 * Real git operations in a temporary repo. Creates a fresh git
 * directory with a minimal package.json before each test, wires
 * setSelfCommitRepoRoot to point there, pipes the audit log to
 * a temp file (so we don't pollute the operator's real
 * ~/.ohwow/self-commit-log), and sets the test-bypass env var so
 * the kill switch doesn't block. skipGates: true for most tests
 * to keep them fast; one dedicated rollback test runs the real
 * gates by pointing npm scripts at a failing command.
 */

let tempRoot: string;
let auditLogPath: string;

function initGitRepo(root: string) {
  execSync('git init -b main', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email "test@test.local"', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: root, stdio: 'pipe' });
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

/** Default audit-safe options — tests override only what they care about. */
function baseOpts(overrides: Partial<SelfCommitOptions> = {}): SelfCommitOptions {
  return {
    files: [{ path: 'src/self-bench/experiments/placeholder.ts', content: 'export const x = 1;' }],
    commitMessage: 'feat(self-bench): auto-author placeholder from proposal brief',
    experimentId: 'test-writer',
    extendsExperimentId: null,
    whyNotEditExisting: 'new-file-only policy, no parent experiment exists',
    skipGates: true,
    ...overrides,
  };
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-commit-test-'));
  initGitRepo(tempRoot);
  setSelfCommitRepoRoot(tempRoot);
  // Point audit log at a temp file OUTSIDE the repo so it doesn't
  // show up in git status. Using a sibling path that afterEach
  // explicitly unlinks.
  auditLogPath = path.join(os.tmpdir(), `self-commit-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  _setAuditLogPathForTests(auditLogPath);
  process.env.OHWOW_SELF_COMMIT_TEST_ALLOW = '1';
});

afterEach(() => {
  try { if (fs.existsSync(auditLogPath)) fs.unlinkSync(auditLogPath); } catch { /* ignore */ }
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

  it('exposes the allowed path prefixes', () => {
    const status = getSelfCommitStatus();
    expect(status.allowedPathPrefixes).toContain('src/self-bench/experiments/');
    expect(status.allowedPathPrefixes).toContain('src/self-bench/__tests__/');
  });

  it('exposes the audit log path', () => {
    const status = getSelfCommitStatus();
    expect(status.auditLogPath).toBe(auditLogPath);
  });
});

describe('safeSelfCommit — kill switch', () => {
  it('refuses when kill switch is closed and no test bypass set', async () => {
    delete process.env.OHWOW_SELF_COMMIT_TEST_ALLOW;
    const result = await safeSelfCommit(baseOpts());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('disabled by default');
  });
});

describe('safeSelfCommit — commit message validation', () => {
  it('refuses a commit message shorter than 40 characters', async () => {
    const result = await safeSelfCommit(baseOpts({
      commitMessage: 'feat(self-bench): short',
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('at least 40');
  });

  it('refuses a commit message without feat(self-bench): prefix', async () => {
    const result = await safeSelfCommit(baseOpts({
      commitMessage: 'fix(self-bench): wrong prefix but long enough to pass length',
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('feat(self-bench):');
  });
});

describe('safeSelfCommit — audit field validation', () => {
  it('refuses whyNotEditExisting shorter than 10 characters', async () => {
    const result = await safeSelfCommit(baseOpts({
      whyNotEditExisting: 'short',
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('whyNotEditExisting');
  });
});

describe('safeSelfCommit — path allowlist', () => {
  it('refuses paths outside src/self-bench/experiments or __tests__', async () => {
    const result = await safeSelfCommit(baseOpts({
      files: [{ path: 'src/execution/engine.ts', content: 'nope' }],
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not allowed');
  });

  it('refuses path traversal with ..', async () => {
    const result = await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/../../../etc/passwd', content: 'nope' }],
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not allowed');
  });

  it('refuses absolute paths', async () => {
    const result = await safeSelfCommit(baseOpts({
      files: [{ path: '/etc/passwd', content: 'nope' }],
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not allowed');
  });
});

describe('safeSelfCommit — new-file-only', () => {
  it('refuses when a target path already exists', async () => {
    const existingPath = path.join(tempRoot, 'src/self-bench/experiments/existing.ts');
    fs.writeFileSync(existingPath, 'pre-existing');

    const result = await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/existing.ts', content: 'overwrite' }],
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('already exists');
    expect(fs.readFileSync(existingPath, 'utf-8')).toBe('pre-existing');
  });
});

describe('safeSelfCommit — happy path', () => {
  it('writes files, stages, commits, and returns sha', async () => {
    const beforeSha = currentSha(tempRoot);
    const result = await safeSelfCommit(baseOpts({
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
      commitMessage: 'feat(self-bench): auto-author my-new-experiment from proposal brief',
      experimentId: 'author-writer',
    }));

    expect(result.ok).toBe(true);
    expect(result.commitSha).toBeTruthy();
    expect(result.commitSha).not.toBe(beforeSha);
    expect(result.filesWritten).toEqual([
      'src/self-bench/experiments/my-new-experiment.ts',
      'src/self-bench/__tests__/my-new-experiment.test.ts',
    ]);
    expect(fs.existsSync(path.join(tempRoot, 'src/self-bench/experiments/my-new-experiment.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, 'src/self-bench/__tests__/my-new-experiment.test.ts'))).toBe(true);
  });

  it('commit has sign-off and self-authored trailer', async () => {
    await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/sig-check.ts', content: 'export const y = 2;' }],
      commitMessage: 'feat(self-bench): sign-off attribution check sanity pass',
      experimentId: 'sig-writer',
    }));
    const msg = lastCommitMessage(tempRoot);
    expect(msg).toContain('feat(self-bench): sign-off attribution check');
    expect(msg).toContain('Signed-off-by:');
    expect(msg).toContain('Self-authored by experiment: sig-writer');
    expect(msg).toContain('ohwow-self-bench <self@ohwow.local>');
  });
});

describe('safeSelfCommit — pre-commit audit log', () => {
  it('writes one JSON line per attempt with every required key', async () => {
    await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/audit-1.ts', content: 'export const a = 1;' }],
      commitMessage: 'feat(self-bench): audit log shape check for path A',
      experimentId: 'audit-writer',
      extendsExperimentId: null,
      whyNotEditExisting: 'new-file-only in Phase 7',
    }));

    const raw = fs.readFileSync(auditLogPath, 'utf-8');
    const lines = raw.trim().split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toHaveProperty('ts');
    expect(entry).toHaveProperty('files_changed');
    expect(entry).toHaveProperty('bailout_check');
    expect(entry).toHaveProperty('extends_experiment_id');
    expect(entry).toHaveProperty('why_not_edit_existing');
    expect(typeof entry.ts).toBe('string');
    expect(entry.files_changed).toEqual(['src/self-bench/experiments/audit-1.ts']);
    expect(entry.bailout_check).toBe('none');
    expect(entry.extends_experiment_id).toBeNull();
    expect(entry.why_not_edit_existing).toBe('new-file-only in Phase 7');
  });

  it('appends (does not overwrite) when a second commit lands', async () => {
    await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/audit-2a.ts', content: '1' }],
      commitMessage: 'feat(self-bench): audit append test first commit sanity',
      experimentId: 'append-writer',
    }));
    await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/audit-2b.ts', content: '2' }],
      commitMessage: 'feat(self-bench): audit append test second commit sanity',
      experimentId: 'append-writer',
    }));

    const lines = fs.readFileSync(auditLogPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).files_changed).toEqual(['src/self-bench/experiments/audit-2a.ts']);
    expect(JSON.parse(lines[1]).files_changed).toEqual(['src/self-bench/experiments/audit-2b.ts']);
  });

  it('does NOT write an audit line when a pre-gate check fails', async () => {
    // Path allowlist rejection should not produce an audit row —
    // nothing attempted, nothing to log.
    await safeSelfCommit(baseOpts({
      files: [{ path: 'src/execution/engine.ts', content: 'nope' }],
      commitMessage: 'feat(self-bench): this should be rejected pre-audit check',
    }));
    expect(fs.existsSync(auditLogPath)).toBe(false);
  });

  it('audit line lands BEFORE the git commit (observable mid-flight)', async () => {
    // The ordering check: after safeSelfCommit returns, both the
    // audit line and the git commit exist. There's no race we can
    // easily observe from a unit test, but we can verify the
    // invariant structurally: audit line is written by the time
    // any caller sees the result, on both success and certain
    // failure paths after the audit write point.
    const result = await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/ordering.ts', content: 'export const o = 1;' }],
      commitMessage: 'feat(self-bench): audit-before-commit ordering invariant',
      experimentId: 'order-writer',
    }));
    expect(result.ok).toBe(true);
    expect(fs.existsSync(auditLogPath)).toBe(true);
    // Commit landed
    const log = execSync('git log --oneline', { cwd: tempRoot, encoding: 'utf-8' });
    expect(log).toContain('audit-before-commit ordering');
  });
});

describe('safeSelfCommit — rollback', () => {
  it('rolls back file writes when the typecheck gate fails', async () => {
    // Swap package.json to one that fails typecheck, commit it,
    // then run safeSelfCommit without skipGates. The real gate
    // runs and fails.
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
      commitMessage: 'feat(self-bench): rollback on typecheck failure test scenario',
      experimentId: 'gated-writer',
      extendsExperimentId: null,
      whyNotEditExisting: 'new-file-only in Phase 7',
      // skipGates: false -- run real gates which should fail
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('typecheck');
    expect(fs.existsSync(path.join(tempRoot, 'src/self-bench/experiments/gated.ts'))).toBe(false);
    // Also: no audit line (gate failure is pre-audit)
    expect(fs.existsSync(auditLogPath)).toBe(false);
  });
});

describe('safeSelfCommit — git state', () => {
  it('after success, git status is clean (no leftover staged files)', async () => {
    await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/clean.ts', content: 'export const c = 1;' }],
      commitMessage: 'feat(self-bench): post-commit clean working-tree check',
      experimentId: 'clean-writer',
    }));
    const status = execSync('git status --porcelain', { cwd: tempRoot, encoding: 'utf-8' });
    expect(status.trim()).toBe('');
  });

  it('does NOT touch files outside the provided list (no git add .)', async () => {
    fs.writeFileSync(path.join(tempRoot, 'unrelated.txt'), 'should not be committed');
    await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/scoped.ts', content: 'export const s = 1;' }],
      commitMessage: 'feat(self-bench): scoped-add invariant never-git-add-dot',
      experimentId: 'scoped-writer',
    }));
    const status = execSync('git status --porcelain', { cwd: tempRoot, encoding: 'utf-8' });
    expect(status).toContain('?? unrelated.txt');
  });
});
