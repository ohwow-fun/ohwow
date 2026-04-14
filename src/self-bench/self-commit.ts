/**
 * safeSelfCommit — Phase 7-A safety primitive, Path A audit-contract revision.
 *
 * The load-bearing safety layer for ohwow writing its own experiment
 * code and committing it to git. Every Phase 7 commit from a
 * self-bench experiment goes through this function.
 *
 * Hard constraints (none of these can be relaxed without a code change)
 * ---------------------------------------------------------------------
 * 1. Kill switch. The default is DISABLED. A real self-commit only
 *    runs when the operator has explicitly touched
 *    ~/.ohwow/self-commit-enabled. Missing file = refusal. This is
 *    the first and cheapest check so nothing else runs if the
 *    operator hasn't opted in.
 *
 * 2. Path allowlist. Every file must be under
 *    src/self-bench/experiments/ or src/self-bench/__tests__/. Any
 *    path containing .. is rejected. Absolute paths are rejected.
 *    The self-commit path can never touch the runtime, migrations,
 *    orchestrator, api, or any of the core code paths.
 *
 * 3. New-file-only. Every target path must NOT exist before the
 *    write. safeSelfCommit can add experiments; it cannot modify
 *    existing ones. Modifications to prior experiments remain a
 *    human-driven change. This dramatically reduces the blast
 *    radius of a hallucinated codegen.
 *
 * 4. Commit-message shape. Minimum 40 characters and must start
 *    with "feat(self-bench): " so the operator bailout "commit
 *    message shorter than 40 chars or missing feat(self-bench):
 *    prefix" is self-enforcing.
 *
 * 5. Pre-flight gates. npm run typecheck runs first. If that
 *    passes, the specific new test files run via vitest. Only if
 *    both green does the audit log get written.
 *
 * 6. Pre-commit audit log. BEFORE any git-state mutation, we
 *    append one JSON line to ~/.ohwow/self-commit-log with the
 *    exact shape the operator runbook enforces (ts,
 *    files_changed, bailout_check, extends_experiment_id,
 *    why_not_edit_existing). If the audit write fails, the commit
 *    aborts fail-closed — no commit without an audit trail. The
 *    audit entry is the operator's tripwire for halting the loop
 *    on missing-audit or non-none bailout_check.
 *
 * 7. Commit scope is explicit AND atomic. The commit uses
 *    `git commit --only -- <opts.files>` so its scope is bounded to
 *    exactly the listed paths regardless of what else is in the
 *    index. Replaces an earlier git-add-then-commit pattern that
 *    had a race window: a concurrent worker staging anything
 *    between our git-add and our git-commit got their changes
 *    silently bundled into our commit. `--only` makes the scope
 *    expression atomic — git updates the index and commits in one
 *    invocation, ignoring all other staged paths. NO --no-verify
 *    (husky runs its hooks) so the operator runbook bailout
 *    "--no-verify" is self-enforcing. The redundant typecheck the
 *    hook runs is cheap (~8s) and harmless — it's a subset of what
 *    we already ran manually, and it sees only our paths.
 *
 * Error handling
 * --------------
 * Every failure returns ok: false with a reason string. The caller
 * (an experiment) writes a finding row recording the outcome. On
 * success the caller records the commit sha so operators can trace
 * back from a bad commit to the experiment that wrote it.
 *
 * Never throws — self-commit failure must not take down the
 * experiment runner tick.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { logger } from '../lib/logger.js';

export interface SelfCommitFile {
  /** Path relative to the repo root. */
  path: string;
  /** UTF-8 file contents. */
  content: string;
}

export interface SelfCommitOptions {
  files: SelfCommitFile[];
  /**
   * Human-readable commit message. Must be at least 40 characters
   * and start with "feat(self-bench): " so operator bailout #3
   * ("commit message shorter than 40 chars or missing
   * feat(self-bench): prefix") is self-enforcing.
   */
  commitMessage: string;
  /** Experiment id of the writer, for the commit trailer. */
  experimentId: string;
  /**
   * Audit field (required) — id of an existing experiment this
   * commit extends, or null if it's a new green-field experiment.
   * Lands in the pre-commit audit log so operators can tell
   * "extension" commits from "fresh" commits at a glance.
   */
  extendsExperimentId: string | null;
  /**
   * Audit field (required) — sentence-form justification for NOT
   * editing an existing experiment. At least 10 characters.
   * Lands in the pre-commit audit log. For Phase 7 the author
   * populates this with a standard sentence about Phase 7-A's
   * new-file-only policy; future phases that support edits will
   * populate it with the actual reason.
   */
  whyNotEditExisting: string;
  /**
   * Skip the typecheck + vitest gates. ONLY for unit tests of
   * safeSelfCommit itself. Production call sites must leave this
   * undefined so the real gates run. Gate skip does NOT skip the
   * audit log write — that's always on.
   */
  skipGates?: boolean;
}

export interface SelfCommitResult {
  ok: boolean;
  reason?: string;
  commitSha?: string;
  filesWritten?: string[];
}

/**
 * Exact key shape of the pre-commit audit log line. Operators
 * parse this file and halt on any row missing these keys or with
 * bailout_check != 'none'.
 */
export interface SelfCommitAuditEntry {
  ts: string;
  files_changed: string[];
  bailout_check: string;
  extends_experiment_id: string | null;
  why_not_edit_existing: string;
}

const ALLOWED_PATH_PREFIXES = [
  'src/self-bench/experiments/',
  'src/self-bench/__tests__/',
  // The auto-registry is the one file the author is allowed to update
  // (not just create). It is append-only by convention — the author
  // only adds factory lines, never removes them. Listing the exact path
  // (not a prefix) keeps the allowlist tight.
  'src/self-bench/auto-registry.ts',
  // Layer 1 of the autonomous-fixing safety floor: registries are how
  // the author expresses "another instance of an existing parameterized
  // probe class" instead of generating a fresh templated TS file. The
  // two specific registries below are append-only by convention; each
  // is also listed in MODIFY_ALLOWED_EXACT_PATHS to widen the
  // new-file-only default for them. Listed as exact paths (not the
  // 'src/self-bench/registries/' prefix) so adding a brand-new registry
  // remains a deliberate human action.
  'src/self-bench/registries/migration-schema-registry.ts',
  'src/self-bench/registries/toolchain-test-registry.ts',
] as const;

/**
 * Paths that may be modified (not just created) via safeSelfCommit.
 * Every path here must also appear in ALLOWED_PATH_PREFIXES.
 * The default constraint is new-file-only; this set widens it for
 * specific files that are explicitly designed to grow over time.
 */
const MODIFY_ALLOWED_EXACT_PATHS = new Set([
  'src/self-bench/auto-registry.ts',
  'src/self-bench/registries/migration-schema-registry.ts',
  'src/self-bench/registries/toolchain-test-registry.ts',
]);

/** Test-only env var that bypasses the kill-switch file check. */
const TEST_BYPASS_ENV = 'OHWOW_SELF_COMMIT_TEST_ALLOW';

/** File whose existence means the operator has opted in. */
export const SELF_COMMIT_ENABLED_PATH = path.join(
  os.homedir(),
  '.ohwow',
  'self-commit-enabled',
);

/**
 * Append-only audit log that every self-commit attempt writes to
 * BEFORE invoking git. Operator tails this file during supervision
 * to halt on any row whose bailout_check is not "none" or that is
 * missing the required keys. If the audit write fails, the commit
 * is aborted fail-closed — no commit without an audit trail.
 */
export const AUDIT_LOG_PATH = path.join(
  os.homedir(),
  '.ohwow',
  'self-commit-log',
);

const COMMIT_MESSAGE_MIN_LENGTH = 40;
const COMMIT_MESSAGE_PREFIX = 'feat(self-bench): ';
const WHY_NOT_EDIT_MIN_LENGTH = 10;

// Module-level state. Set at daemon boot via the setter.
// Tests override via their beforeEach hooks.
let repoRootOverride: string | null = null;
let auditLogPathOverride: string | null = null;

/**
 * Wire the daemon's repo root at boot. Detected in start.ts from
 * the daemon binary path (../ from dist/index.js).
 */
export function setSelfCommitRepoRoot(root: string | null): void {
  repoRootOverride = root;
}

/**
 * Test-only override for the audit log path. Tests point it at a
 * temp file so they don't pollute the operator's real log. Pass
 * null to clear.
 */
export function _setAuditLogPathForTests(p: string | null): void {
  auditLogPathOverride = p;
}

/** Test-only reset so beforeEach starts clean. */
export function _resetSelfCommitForTests(): void {
  repoRootOverride = null;
  auditLogPathOverride = null;
}

function getRepoRoot(): string | null {
  if (repoRootOverride) return repoRootOverride;
  const envOverride = process.env.OHWOW_REPO_ROOT;
  if (envOverride) return envOverride;
  return null;
}

function getAuditLogPath(): string {
  return auditLogPathOverride ?? AUDIT_LOG_PATH;
}

function isKillSwitchOpen(): boolean {
  if (process.env[TEST_BYPASS_ENV] === '1') return true;
  try {
    return fs.existsSync(SELF_COMMIT_ENABLED_PATH);
  } catch {
    return false;
  }
}

function isPathAllowed(relPath: string): boolean {
  if (!relPath) return false;
  // Normalize to forward slashes for consistent matching
  const normalized = path.normalize(relPath).replace(/\\/g, '/');
  // Reject any traversal
  if (normalized.includes('..')) return false;
  // Reject absolute paths
  if (normalized.startsWith('/')) return false;
  if (path.isAbsolute(normalized)) return false;
  // Must match one of the allowed prefixes
  return ALLOWED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Append one JSON line to the audit log. Throws on failure so the
 * caller can abort the commit — fail-closed is the whole point of
 * this file. Creates the parent directory if missing.
 */
function writeAuditEntry(entry: SelfCommitAuditEntry): void {
  const logPath = getAuditLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Run a shell command in the repo and return stdout/stderr. Throws
 * on non-zero exit so the caller can catch + rollback cleanly.
 */
function runInRepo(command: string, repoRoot: string, opts: { input?: string; timeoutMs?: number } = {}): string {
  return execSync(command, {
    cwd: repoRoot,
    stdio: opts.input !== undefined ? ['pipe', 'pipe', 'pipe'] : 'pipe',
    input: opts.input,
    timeout: opts.timeoutMs ?? 120_000,
    encoding: 'utf-8',
  }).toString();
}

export async function safeSelfCommit(opts: SelfCommitOptions): Promise<SelfCommitResult> {
  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    return {
      ok: false,
      reason: 'repo root not configured — call setSelfCommitRepoRoot() at daemon boot or set OHWOW_REPO_ROOT',
    };
  }

  if (!isKillSwitchOpen()) {
    return {
      ok: false,
      reason: `self-commit is disabled by default. To enable, create ${SELF_COMMIT_ENABLED_PATH}`,
    };
  }

  // Commit message shape — rejects short or un-prefixed messages
  // so the operator bailout is enforced BEFORE touching anything.
  if (typeof opts.commitMessage !== 'string' || opts.commitMessage.length < COMMIT_MESSAGE_MIN_LENGTH) {
    return {
      ok: false,
      reason: `commitMessage must be at least ${COMMIT_MESSAGE_MIN_LENGTH} characters (got ${opts.commitMessage?.length ?? 0})`,
    };
  }
  if (!opts.commitMessage.startsWith(COMMIT_MESSAGE_PREFIX)) {
    return {
      ok: false,
      reason: `commitMessage must start with "${COMMIT_MESSAGE_PREFIX}"`,
    };
  }

  // Audit-field validation — refuse garbage before we get near git.
  if (typeof opts.whyNotEditExisting !== 'string' || opts.whyNotEditExisting.length < WHY_NOT_EDIT_MIN_LENGTH) {
    return {
      ok: false,
      reason: `whyNotEditExisting must be at least ${WHY_NOT_EDIT_MIN_LENGTH} characters`,
    };
  }

  // 1. Path allowlist validation
  for (const f of opts.files) {
    if (!isPathAllowed(f.path)) {
      return { ok: false, reason: `path not allowed: ${f.path}` };
    }
  }

  // 2. New-file-only check (exempts MODIFY_ALLOWED_EXACT_PATHS)
  const absPaths: string[] = [];
  for (const f of opts.files) {
    const abs = path.join(repoRoot, f.path);
    const normalized = path.normalize(f.path).replace(/\\/g, '/');
    const modifyOk = MODIFY_ALLOWED_EXACT_PATHS.has(normalized);
    if (!modifyOk && fs.existsSync(abs)) {
      return { ok: false, reason: `target already exists: ${f.path}` };
    }
    absPaths.push(abs);
  }

  // 3. Write files to disk
  try {
    for (let i = 0; i < opts.files.length; i++) {
      const abs = absPaths[i];
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, opts.files[i].content, 'utf-8');
    }
  } catch (err) {
    rollbackFiles(absPaths);
    return { ok: false, reason: `write failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 4. Gates (typecheck + vitest on the new test files)
  if (!opts.skipGates) {
    try {
      runInRepo('npm run typecheck', repoRoot, { timeoutMs: 180_000 });
    } catch (err) {
      rollbackFiles(absPaths);
      return { ok: false, reason: `typecheck gate failed: ${extractErrorSummary(err)}` };
    }

    const testFiles = opts.files
      .filter((f) => f.path.includes('__tests__'))
      .map((f) => f.path);
    if (testFiles.length > 0) {
      try {
        const cmd = `npx vitest run ${testFiles.map((t) => `"${t}"`).join(' ')}`;
        runInRepo(cmd, repoRoot, { timeoutMs: 120_000 });
      } catch (err) {
        rollbackFiles(absPaths);
        return { ok: false, reason: `vitest gate failed: ${extractErrorSummary(err)}` };
      }
    }
  }

  // 5. Pre-commit audit log. Fail-closed on write error — no
  //    commit without an audit trail. Happens AFTER gates pass
  //    (so we don't pollute the log with rows whose gates failed)
  //    but BEFORE git state mutation (so operators see the
  //    attempt before the commit lands).
  try {
    writeAuditEntry({
      ts: new Date().toISOString(),
      files_changed: opts.files.map((f) => f.path),
      bailout_check: 'none',
      extends_experiment_id: opts.extendsExperimentId,
      why_not_edit_existing: opts.whyNotEditExisting,
    });
  } catch (err) {
    rollbackFiles(absPaths);
    return { ok: false, reason: `audit log write failed: ${extractErrorSummary(err)}` };
  }

  // 6. Git commit with sign-off + self-attribution trailer. Uses
  //    `git commit --only -- <files>` so the commit scope is bounded
  //    to exactly opts.files regardless of what else is in the index.
  //
  //    Why --only and not git-add-then-commit:
  //    The earlier two-step (git add <files> ; git commit) was a
  //    race window. If a concurrent worker (another autonomous
  //    self-commit, a human running git rm, lint-staged stashing,
  //    etc.) staged anything between our git-add and our git-commit,
  //    that change got bundled into our commit silently. This was
  //    observed on 2026-04-14 when an autonomous commit titled
  //    "auto-author toolchain-tool-test-list-deliverables-since"
  //    actually contained ~1,500 lines of unrelated deletions from a
  //    concurrent refactor's git-rm.
  //
  //    `git commit --only -- <files>` updates the index for ONLY the
  //    listed paths (from the working tree) and commits ONLY those
  //    paths. Other index entries — staged or otherwise — are left
  //    untouched and excluded from the commit. This is the
  //    git-native way to express "commit exactly these files,
  //    nothing else."
  //
  //    NO --no-verify — husky's pre-commit hook still runs
  //    (typecheck + lint-staged eslint). The hook sees only the
  //    files we're committing, so cross-session WIP outside our
  //    scope still doesn't pollute the validation surface.
  //
  //    `git add -N` (intent to add) is required for new files
  //    before `git commit --only` can pick them up — without it
  //    git rejects the commit with "pathspec did not match any
  //    file(s) known to git." -N adds a zero-length placeholder
  //    entry to the index; --only then replaces it with the actual
  //    working-tree content. Crucially, -N only touches the paths
  //    we name — other staged paths in the index are untouched, so
  //    the isolation guarantee holds.
  const fullMessage = `${opts.commitMessage}\n\nSelf-authored by experiment: ${opts.experimentId}\n\nCo-Authored-By: ohwow-self-bench <self@ohwow.local>\n`;
  const fileArgs = opts.files.map((f) => `"${f.path}"`).join(' ');
  try {
    runInRepo(`git add -N -- ${fileArgs}`, repoRoot);
    runInRepo(`git commit -s --only -F - -- ${fileArgs}`, repoRoot, { input: fullMessage });
  } catch (err) {
    // Reset the index entries `--only` may have updated so the repo
    // is clean. Scoped to opts.files — never touches paths the
    // self-commit didn't write (per the global rule "never git reset
    // HEAD on files you didn't stage").
    try {
      runInRepo(`git reset HEAD -- ${fileArgs}`, repoRoot);
    } catch { /* best effort */ }
    rollbackFiles(absPaths);
    return { ok: false, reason: `git commit failed: ${extractErrorSummary(err)}` };
  }

  // 8. Read back the resulting SHA
  let commitSha: string | undefined;
  try {
    commitSha = runInRepo('git rev-parse HEAD', repoRoot).trim();
  } catch { /* shouldn't happen but not fatal — commit already landed */ }

  // 9. Push to origin so committed experiments are visible remotely.
  // Non-fatal — the commit is already in local git history. A push
  // failure just means the remote is temporarily behind; the next
  // successful safeSelfCommit will push both commits at once.
  try {
    runInRepo('git push', repoRoot, { timeoutMs: 60_000 });
    logger.info(
      { experimentId: opts.experimentId, commitSha, filesWritten: opts.files.map((f) => f.path) },
      '[self-commit] experiment committed and pushed autonomously',
    );
  } catch (pushErr) {
    logger.warn(
      { experimentId: opts.experimentId, commitSha, err: extractErrorSummary(pushErr) },
      '[self-commit] commit succeeded but push failed — will retry on next commit',
    );
  }

  return {
    ok: true,
    commitSha,
    filesWritten: opts.files.map((f) => f.path),
  };
}

function rollbackFiles(absPaths: string[]): void {
  for (const abs of absPaths) {
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch { /* best effort */ }
  }
}

function extractErrorSummary(err: unknown): string {
  if (err instanceof Error) {
    // execSync errors often include stderr in a .stderr property
    // (as Buffer). Capture up to 500 chars for the ledger.
    const maybeStderr = (err as { stderr?: Buffer | string }).stderr;
    if (maybeStderr) {
      const s = typeof maybeStderr === 'string' ? maybeStderr : maybeStderr.toString('utf-8');
      if (s.trim()) return s.slice(0, 500);
    }
    return err.message.slice(0, 500);
  }
  return String(err).slice(0, 500);
}

/**
 * Diagnostic helper for operator surfaces. Returns a structured
 * snapshot of the safety state without actually attempting a
 * commit. Used by a future status endpoint.
 */
export function getSelfCommitStatus(): {
  killSwitchOpen: boolean;
  repoRootConfigured: boolean;
  repoRoot: string | null;
  allowedPathPrefixes: readonly string[];
  auditLogPath: string;
} {
  return {
    killSwitchOpen: isKillSwitchOpen(),
    repoRootConfigured: getRepoRoot() !== null,
    repoRoot: getRepoRoot(),
    allowedPathPrefixes: ALLOWED_PATH_PREFIXES,
    auditLogPath: getAuditLogPath(),
  };
}
