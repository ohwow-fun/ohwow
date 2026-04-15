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
  _setKillSwitchDisabledPathForTests,
  getSelfCommitStatus,
  type SelfCommitOptions,
  type FindingLookup,
} from '../self-commit.js';
import { _setPathTierRegistryForTests } from '../path-trust-tiers.js';

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
  // Kill switch defaults to open (opt-out model). No env var needed.
});

afterEach(() => {
  try { if (fs.existsSync(auditLogPath)) fs.unlinkSync(auditLogPath); } catch { /* ignore */ }
});

afterEach(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  _resetSelfCommitForTests();
  _setPathTierRegistryForTests(null);
});

describe('getSelfCommitStatus', () => {
  it('reports killSwitchOpen by default (opt-out model)', () => {
    // Kill switch is open by default — no disabled file means it runs.
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
  it('refuses when kill switch is force-closed via TEST_DENY env var', async () => {
    process.env.OHWOW_SELF_COMMIT_TEST_DENY = '1';
    try {
      const result = await safeSelfCommit(baseOpts());
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('disabled by default');
    } finally {
      delete process.env.OHWOW_SELF_COMMIT_TEST_DENY;
    }
  });

  it('refuses when the disabled file exists at the overridden path', async () => {
    const disabledFile = path.join(os.tmpdir(), `self-commit-disabled-${Date.now()}`);
    fs.writeFileSync(disabledFile, '');
    _setKillSwitchDisabledPathForTests(disabledFile);
    try {
      const result = await safeSelfCommit(baseOpts());
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('disabled by default');
    } finally {
      _setKillSwitchDisabledPathForTests(null);
      try { fs.unlinkSync(disabledFile); } catch { /* ignore */ }
    }
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
    expect(entry).toHaveProperty('fixes_finding_id');
    expect(entry.fixes_finding_id).toBeNull();
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

describe('safeSelfCommit — Layer 9 tier-2 paths require a finding receipt', () => {
  const TIER2_PATH = 'src/lib/formatting/date.ts';
  const FINDING_ID = '99999999-aaaa-bbbb-cccc-dddddddddddd';

  function wireTier2() {
    _setPathTierRegistryForTests([
      {
        prefix: 'src/self-bench/experiments/',
        tier: 'tier-1',
        rationale: 'sandbox',
      },
      {
        prefix: 'src/lib/formatting/',
        tier: 'tier-2',
        rationale: 'pure formatters — needs receipt',
      },
    ]);
  }

  function seedTier2File() {
    // Pre-existing one-symbol file so Layer 4's modify check passes
    // when we replace its single declaration.
    fs.mkdirSync(path.join(tempRoot, 'src/lib/formatting'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, TIER2_PATH),
      `export function formatDate(d: Date) { return d.toISOString(); }\n`,
    );
    execSync(`git add ${TIER2_PATH} && git commit -m "seed"`, { cwd: tempRoot, stdio: 'pipe' });
  }

  it('refuses a tier-2 path without a Fixes-Finding-Id', async () => {
    wireTier2();
    seedTier2File();
    const result = await safeSelfCommit(baseOpts({
      files: [{ path: TIER2_PATH, content: `export function formatDate(d: Date) { return 'x'; }\n` }],
      commitMessage: 'feat(self-bench): tier-2 refused without a receipt test',
      experimentId: 'l9-writer',
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('tier-2');
    expect(result.reason).toContain('Fixes-Finding-Id');
  });

  it('allows a tier-2 path when a valid Fixes-Finding-Id + resolver are supplied', async () => {
    wireTier2();
    seedTier2File();
    const result = await safeSelfCommit(baseOpts({
      files: [{ path: TIER2_PATH, content: `export function formatDate(d: Date) { return 'x'; }\n` }],
      commitMessage: 'feat(self-bench): tier-2 allowed with valid receipt',
      experimentId: 'l9-writer',
      fixesFindingId: FINDING_ID,
      findingResolver: async () => ({
        id: FINDING_ID,
        verdict: 'warning',
        ranAt: new Date().toISOString(),
        affectedFiles: [TIER2_PATH],
      }),
    }));
    expect(result.ok).toBe(true);
  });

  it('refuses a tier-3 path regardless of any finding receipt', async () => {
    wireTier2();
    const result = await safeSelfCommit(baseOpts({
      files: [{ path: 'src/orchestrator/engine.ts', content: 'export const x = 1;' }],
      commitMessage: 'feat(self-bench): tier-3 never-autonomous refusal check',
      experimentId: 'l9-writer',
      fixesFindingId: FINDING_ID,
      findingResolver: async () => ({
        id: FINDING_ID,
        verdict: 'fail',
        ranAt: new Date().toISOString(),
        affectedFiles: ['src/orchestrator/engine.ts'],
      }),
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not allowed');
  });
});

describe('safeSelfCommit — Layer 7 daily commit budget', () => {
  afterEach(() => {
    delete process.env.OHWOW_SELF_COMMIT_DAILY_BUDGET;
  });

  it('refuses when 24h autonomous commit count has reached the budget', async () => {
    // Seed 3 autonomous commits carrying the trailer, set budget=3.
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(tempRoot, `a${i}.ts`), `export const x${i} = ${i};\n`);
      execSync(`git add a${i}.ts`, { cwd: tempRoot, stdio: 'pipe' });
      const msgFile = path.join(tempRoot, '.git', 'COMMIT_MSG');
      fs.writeFileSync(msgFile, `chore: seed ${i}\n\nSelf-authored by experiment: seeder\n`);
      execSync(`git commit -F "${msgFile}"`, { cwd: tempRoot, stdio: 'pipe' });
    }
    process.env.OHWOW_SELF_COMMIT_DAILY_BUDGET = '3';

    const result = await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/budget-hit.ts', content: 'export const z = 1;' }],
      commitMessage: 'feat(self-bench): should be refused by daily budget cap',
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('daily autonomous commit budget');
    expect(result.reason).toContain('3/3');
    // File was not written (refusal is pre-write)
    expect(fs.existsSync(path.join(tempRoot, 'src/self-bench/experiments/budget-hit.ts'))).toBe(false);
  });

  it('allows the commit when under budget', async () => {
    // 1 autonomous commit seeded, budget=5 → under budget.
    fs.writeFileSync(path.join(tempRoot, 'one.ts'), `export const x = 1;\n`);
    execSync(`git add one.ts`, { cwd: tempRoot, stdio: 'pipe' });
    const msgFile = path.join(tempRoot, '.git', 'COMMIT_MSG');
    fs.writeFileSync(msgFile, `chore: seed\n\nSelf-authored by experiment: seeder\n`);
    execSync(`git commit -F "${msgFile}"`, { cwd: tempRoot, stdio: 'pipe' });
    process.env.OHWOW_SELF_COMMIT_DAILY_BUDGET = '5';

    const result = await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/under-budget.ts', content: 'export const z = 1;' }],
      commitMessage: 'feat(self-bench): under-budget path happy test case',
    }));
    expect(result.ok).toBe(true);
  });

  it('ignores non-autonomous commits when counting', async () => {
    // 5 commits without the trailer — should not count against budget.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tempRoot, `h${i}.ts`), `export const x${i} = ${i};\n`);
      execSync(`git add h${i}.ts && git commit -m "chore: hand-written ${i}"`, {
        cwd: tempRoot,
        stdio: 'pipe',
      });
    }
    process.env.OHWOW_SELF_COMMIT_DAILY_BUDGET = '1';

    const result = await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/human-doesnt-count.ts', content: 'export const z = 1;' }],
      commitMessage: 'feat(self-bench): hand-written commits ignored by budget',
    }));
    expect(result.ok).toBe(true);
  });

  it('falls back to default budget when env var is invalid', async () => {
    // With budget=0 via env, any commit would be refused. A non-numeric
    // env var should NOT silently disable the cap; it should fall
    // back to the generous default (~1/min) which allows this one-off.
    process.env.OHWOW_SELF_COMMIT_DAILY_BUDGET = 'not-a-number';
    const result = await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/env-fallback.ts', content: 'export const z = 1;' }],
      commitMessage: 'feat(self-bench): invalid env falls back to default',
    }));
    expect(result.ok).toBe(true);
  });
});

describe('safeSelfCommit — Layer 4 AST-bounded patch surface', () => {
  const REGISTRY = 'src/self-bench/registries/toolchain-test-registry.ts';

  it('allows a one-symbol modify (registry row append)', async () => {
    fs.mkdirSync(path.join(tempRoot, 'src/self-bench/registries'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, REGISTRY),
      `export const R = [ { slug: 'a' } ];\n`,
    );
    execSync(`git add ${REGISTRY} && git commit -m "seed"`, { cwd: tempRoot, stdio: 'pipe' });

    const result = await safeSelfCommit(baseOpts({
      files: [{
        path: REGISTRY,
        content: `export const R = [ { slug: 'a' }, { slug: 'b' } ];\n`,
      }],
      commitMessage: 'feat(self-bench): layer-4 one-symbol-modify happy path check',
      experimentId: 'l4-writer',
    }));
    expect(result.ok).toBe(true);
  });

  it('refuses a modify that touches two top-level symbols', async () => {
    fs.mkdirSync(path.join(tempRoot, 'src/self-bench/registries'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, REGISTRY),
      `export const R = [ { slug: 'a' } ];\n`,
    );
    execSync(`git add ${REGISTRY} && git commit -m "seed"`, { cwd: tempRoot, stdio: 'pipe' });

    const result = await safeSelfCommit(baseOpts({
      files: [{
        path: REGISTRY,
        content:
          `import type { T } from './t.js';\n` +
          `export const R = [ { slug: 'a' }, { slug: 'b' } ];\n`,
      }],
      commitMessage: 'feat(self-bench): layer-4 two-symbol modify must be refused',
      experimentId: 'l4-writer',
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('AST-bounded patch surface');
    expect(result.reason).toContain('2 top-level symbols');

    // Pre-write bytes restored on rollback
    const after = fs.readFileSync(path.join(tempRoot, REGISTRY), 'utf-8');
    expect(after).toBe(`export const R = [ { slug: 'a' } ];\n`);
  });

  it('does not apply to new-file creates (no prior AST to diff)', async () => {
    // A fresh experiment file can have as many declarations as it
    // needs — Layer 4 only gates modifies.
    const result = await safeSelfCommit(baseOpts({
      files: [{
        path: 'src/self-bench/experiments/multi-symbol-new.ts',
        content:
          `export const a = 1;\nexport const b = 2;\nexport function c() { return 3; }\n`,
      }],
      commitMessage: 'feat(self-bench): layer-4 creates-are-unbounded regression guard',
      experimentId: 'l4-writer',
    }));
    expect(result.ok).toBe(true);
  });
});

describe('safeSelfCommit — Layer 3 invariant suite', () => {
  it('refuses a patched experiment that imports from orchestrator/', async () => {
    const result = await safeSelfCommit(baseOpts({
      files: [{
        path: 'src/self-bench/experiments/bad.ts',
        content: `import { x } from '../../orchestrator/engine.js';\nexport const y = 1;\n`,
      }],
      commitMessage: 'feat(self-bench): layer-3 blast-radius invariant refusal test',
      experimentId: 'l3-writer',
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('forbidden module');
    // File rolled back
    expect(fs.existsSync(path.join(tempRoot, 'src/self-bench/experiments/bad.ts'))).toBe(false);
    // No audit line written (gate refusal is pre-audit)
    expect(fs.existsSync(auditLogPath)).toBe(false);
  });

  it('refuses a patched test file with a .only focus', async () => {
    const result = await safeSelfCommit(baseOpts({
      files: [{
        path: 'src/self-bench/__tests__/focused.test.ts',
        content: `import { it, expect } from 'vitest';\nit.only('x', () => expect(1).toBe(1));\n`,
      }],
      commitMessage: 'feat(self-bench): layer-3 tests-shape .only refusal case',
      experimentId: 'l3-writer',
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('.only');
  });
});

describe('safeSelfCommit — Layer 2 fixesFindingId gate', () => {
  const EXAMPLE_UUID = '11111111-2222-3333-4444-555555555555';
  const PATCHED_FILE = 'src/self-bench/experiments/layer2-target.ts';

  function makeFinding(overrides: Partial<FindingLookup> = {}): FindingLookup {
    return {
      id: EXAMPLE_UUID,
      verdict: 'warning',
      ranAt: new Date().toISOString(),
      affectedFiles: [PATCHED_FILE],
      ...overrides,
    };
  }

  function l2Opts(overrides: Partial<SelfCommitOptions> = {}): SelfCommitOptions {
    return baseOpts({
      files: [{ path: PATCHED_FILE, content: 'export const t = 1;' }],
      commitMessage: 'feat(self-bench): layer-2 gate test patch against finding',
      experimentId: 'layer2-writer',
      fixesFindingId: EXAMPLE_UUID,
      findingResolver: async () => makeFinding(),
      ...overrides,
    });
  }

  it('refuses when fixesFindingId is set but resolver is missing', async () => {
    const result = await safeSelfCommit(l2Opts({ findingResolver: undefined }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('findingResolver is required');
  });

  it('refuses when the resolver returns null', async () => {
    const result = await safeSelfCommit(l2Opts({ findingResolver: async () => null }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it("refuses when the finding's verdict is 'pass'", async () => {
    const result = await safeSelfCommit(
      l2Opts({ findingResolver: async () => makeFinding({ verdict: 'pass' }) }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('pass');
  });

  it('refuses when the finding is older than 7 days', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const result = await safeSelfCommit(
      l2Opts({ findingResolver: async () => makeFinding({ ranAt: eightDaysAgo }) }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('stale');
  });

  it('refuses when affected_files does not intersect patched files', async () => {
    const result = await safeSelfCommit(
      l2Opts({
        findingResolver: async () =>
          makeFinding({ affectedFiles: ['src/self-bench/experiments/something-else.ts'] }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('does not intersect');
  });

  it('happy path: trailer appears in commit message and audit log records linkage', async () => {
    const result = await safeSelfCommit(l2Opts());
    expect(result.ok).toBe(true);

    const msg = lastCommitMessage(tempRoot);
    expect(msg).toContain(`Fixes-Finding-Id: ${EXAMPLE_UUID}`);

    const lines = fs.readFileSync(auditLogPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    expect(entry.fixes_finding_id).toBe(EXAMPLE_UUID);
  });

  it('fixesFindingId absent: no trailer, audit line has fixes_finding_id: null (regression guard)', async () => {
    const result = await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/no-fix.ts', content: 'export const n = 1;' }],
      commitMessage: 'feat(self-bench): no-fix path regression guard for layer 2 absence',
      experimentId: 'nofix-writer',
    }));
    expect(result.ok).toBe(true);

    const msg = lastCommitMessage(tempRoot);
    expect(msg).not.toContain('Fixes-Finding-Id');

    const lines = fs.readFileSync(auditLogPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    expect(entry.fixes_finding_id).toBeNull();
  });

  it('does not write audit line when the finding gate fails', async () => {
    await safeSelfCommit(l2Opts({ findingResolver: async () => null }));
    expect(fs.existsSync(auditLogPath)).toBe(false);
  });

  it('rolls back file writes when the finding gate fails', async () => {
    await safeSelfCommit(l2Opts({ findingResolver: async () => null }));
    expect(fs.existsSync(path.join(tempRoot, PATCHED_FILE))).toBe(false);
  });
});

describe('safeSelfCommit — concurrent staging isolation (race condition fix)', () => {
  it('does not bundle a concurrently-staged unrelated file into the commit', async () => {
    // Simulate the failure mode that produced commit 0948ede on
    // 2026-04-14: a concurrent worker stages an unrelated file
    // between when safeSelfCommit's git-add ran and when its
    // git-commit ran. Pre-fix, the unrelated file got swept into
    // the autonomous commit, mis-attributing ~1500 lines of
    // unrelated changes to a "auto-author X" message.
    //
    // With --only the commit scope is bounded to opts.files
    // regardless of what else is in the index — staged or otherwise.
    fs.writeFileSync(path.join(tempRoot, 'concurrent.txt'), 'staged by another worker');
    execSync('git add concurrent.txt', { cwd: tempRoot, stdio: 'pipe' });

    const result = await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/iso.ts', content: 'export const iso = 1;' }],
      commitMessage: 'feat(self-bench): isolation regression test for race condition',
      experimentId: 'iso-writer',
    }));
    expect(result.ok).toBe(true);

    // The commit must list ONLY iso.ts. concurrent.txt must remain
    // staged (not committed) so the concurrent worker's intent
    // is preserved.
    const filesInCommit = execSync('git show --name-only --pretty=format: HEAD', {
      cwd: tempRoot,
      encoding: 'utf-8',
    }).trim().split('\n').filter(Boolean);
    expect(filesInCommit).toEqual(['src/self-bench/experiments/iso.ts']);

    const status = execSync('git status --porcelain', { cwd: tempRoot, encoding: 'utf-8' });
    expect(status).toContain('A  concurrent.txt'); // still staged, not committed
  });

  it('does not bundle a concurrently-staged DELETION into the commit', async () => {
    // The exact shape of 0948ede's failure: a concurrent worker had
    // git-rm'd 18 toolchain duplicate files. The autonomous commit
    // bundled those deletions silently. With --only the deletions
    // stay staged, untouched.
    fs.writeFileSync(path.join(tempRoot, 'will-be-removed.txt'), 'soon to be deleted');
    execSync('git add will-be-removed.txt', { cwd: tempRoot, stdio: 'pipe' });
    execSync('git commit -m "init the file"', { cwd: tempRoot, stdio: 'pipe' });
    execSync('git rm will-be-removed.txt', { cwd: tempRoot, stdio: 'pipe' });

    const result = await safeSelfCommit(baseOpts({
      files: [{ path: 'src/self-bench/experiments/iso2.ts', content: 'export const iso2 = 1;' }],
      commitMessage: 'feat(self-bench): isolation regression for staged deletions',
      experimentId: 'iso2-writer',
    }));
    expect(result.ok).toBe(true);

    const filesInCommit = execSync('git show --name-only --pretty=format: HEAD', {
      cwd: tempRoot,
      encoding: 'utf-8',
    }).trim().split('\n').filter(Boolean);
    expect(filesInCommit).toEqual(['src/self-bench/experiments/iso2.ts']);

    // The deletion must remain staged — concurrent worker's intent preserved.
    const status = execSync('git status --porcelain', { cwd: tempRoot, encoding: 'utf-8' });
    expect(status).toContain('D  will-be-removed.txt');
  });
});

describe('safeSelfCommit — roadmap shape gate', () => {
  function seedRoadmapSuite(root: string) {
    fs.writeFileSync(
      path.join(root, 'AUTONOMY_ROADMAP.md'),
      '# AUTONOMY_ROADMAP.md\n\nSee [roadmap/gaps.md](roadmap/gaps.md) and [roadmap/iteration-log.md](roadmap/iteration-log.md).\n\n## 2. Active Focus\nfocus\n',
    );
    fs.mkdirSync(path.join(root, 'roadmap'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'roadmap/gaps.md'),
      '# Known Gaps\n\n[../AUTONOMY_ROADMAP.md](../AUTONOMY_ROADMAP.md)\n\n## Known Gaps\n\n### P0 — Something\nbody\n',
    );
    fs.writeFileSync(
      path.join(root, 'roadmap/iteration-log.md'),
      '# Iteration Log\n\n[../AUTONOMY_ROADMAP.md](../AUTONOMY_ROADMAP.md)\n\n## Recent Iterations\n\n### 2026-04-15 — Entry\nbody\n',
    );
    execSync('git add AUTONOMY_ROADMAP.md roadmap/', { cwd: root, stdio: 'pipe' });
    execSync('git commit -m "seed roadmap suite"', { cwd: root, stdio: 'pipe' });
  }

  it('rolls back a gaps.md patch that drops the ## Known Gaps anchor', async () => {
    seedRoadmapSuite(tempRoot);
    const shaBefore = currentSha(tempRoot);

    const finding: FindingLookup = {
      id: 'shape-test-finding',
      verdict: 'warning',
      ranAt: new Date().toISOString(),
      affectedFiles: ['roadmap/gaps.md'],
    };

    const result = await safeSelfCommit(baseOpts({
      files: [{
        path: 'roadmap/gaps.md',
        content: '# Known Gaps\n\n[../AUTONOMY_ROADMAP.md](../AUTONOMY_ROADMAP.md)\n\n## Gaps\n\n### P0 — Something\nbody\n',
      }],
      commitMessage: 'feat(self-bench): refresh Known Gaps section from live loop state',
      experimentId: 'roadmap-updater',
      fixesFindingId: finding.id,
      findingResolver: async (id) => (id === finding.id ? finding : null),
    }));

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('roadmap shape gate');
    expect(result.reason).toContain('missing-h2');
    // Rollback worked: file on disk is the seeded version, and HEAD
    // hasn't moved.
    const onDisk = fs.readFileSync(path.join(tempRoot, 'roadmap/gaps.md'), 'utf-8');
    expect(onDisk).toContain('## Known Gaps');
    expect(currentSha(tempRoot)).toBe(shaBefore);
  });
});
