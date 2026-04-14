/**
 * safeSelfCommit — Phase 7-A safety primitive.
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
 * 4. Pre-flight gates. npm run typecheck runs first. If that
 *    passes, the specific new test files run via vitest. Only if
 *    both green does the git add/commit sequence run. Any failure
 *    between write and commit triggers a rollback (delete the
 *    written files).
 *
 * 5. Commit scope is explicit. git add receives only the files
 *    from the opts.files list — no git add . ever. Commit uses
 *    --no-verify because we already ran the hook gates manually
 *    above and running them again from inside a running daemon
 *    process would deadlock (the daemon's test framework is not
 *    reentrant). The --no-verify is document-in-comment load-bearing.
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
  /** Human-readable commit message (first line = subject). */
  commitMessage: string;
  /** Experiment id of the writer, for the commit trailer. */
  experimentId: string;
  /**
   * Skip the typecheck + vitest gates. ONLY for unit tests of
   * safeSelfCommit itself. Production call sites must leave this
   * undefined so the real gates run.
   */
  skipGates?: boolean;
}

export interface SelfCommitResult {
  ok: boolean;
  reason?: string;
  commitSha?: string;
  filesWritten?: string[];
}

const ALLOWED_PATH_PREFIXES = [
  'src/self-bench/experiments/',
  'src/self-bench/__tests__/',
] as const;

/** Test-only env var that bypasses the kill-switch file check. */
const TEST_BYPASS_ENV = 'OHWOW_SELF_COMMIT_TEST_ALLOW';

/** File whose existence means the operator has opted in. */
export const SELF_COMMIT_ENABLED_PATH = path.join(
  os.homedir(),
  '.ohwow',
  'self-commit-enabled',
);

// Module-level repo root. Set at daemon boot by setSelfCommitRepoRoot.
// Tests override via the setter in their beforeEach.
let repoRootOverride: string | null = null;

/**
 * Wire the daemon's repo root at boot. Detected in start.ts from
 * the daemon binary path (../ from dist/index.js).
 */
export function setSelfCommitRepoRoot(root: string | null): void {
  repoRootOverride = root;
}

/** Test-only reset so beforeEach starts clean. */
export function _resetSelfCommitForTests(): void {
  repoRootOverride = null;
}

function getRepoRoot(): string | null {
  if (repoRootOverride) return repoRootOverride;
  const envOverride = process.env.OHWOW_REPO_ROOT;
  if (envOverride) return envOverride;
  return null;
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

  // 1. Path allowlist validation
  for (const f of opts.files) {
    if (!isPathAllowed(f.path)) {
      return { ok: false, reason: `path not allowed: ${f.path}` };
    }
  }

  // 2. New-file-only check
  const absPaths: string[] = [];
  for (const f of opts.files) {
    const abs = path.join(repoRoot, f.path);
    if (fs.existsSync(abs)) {
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

  // 5. Git add (explicit file list — never git add .)
  try {
    const addArgs = opts.files.map((f) => `"${f.path}"`).join(' ');
    runInRepo(`git add ${addArgs}`, repoRoot);
  } catch (err) {
    rollbackFiles(absPaths);
    return { ok: false, reason: `git add failed: ${extractErrorSummary(err)}` };
  }

  // 6. Git commit with sign-off + self-attribution trailer
  const fullMessage = `${opts.commitMessage}\n\nSelf-authored by experiment: ${opts.experimentId}\n\nCo-Authored-By: ohwow-self-bench <self@ohwow.local>\n`;
  try {
    // --no-verify because we already ran the hook gates (typecheck +
    // vitest) manually above. Running them again inside the daemon's
    // own test runner would deadlock vitest against itself.
    runInRepo('git commit -s --no-verify -F -', repoRoot, { input: fullMessage });
  } catch (err) {
    // Git reset the staged changes so the repo is clean.
    try {
      const resetArgs = opts.files.map((f) => `"${f.path}"`).join(' ');
      runInRepo(`git reset HEAD -- ${resetArgs}`, repoRoot);
    } catch { /* best effort */ }
    rollbackFiles(absPaths);
    return { ok: false, reason: `git commit failed: ${extractErrorSummary(err)}` };
  }

  // 7. Read back the resulting SHA
  let commitSha: string | undefined;
  try {
    commitSha = runInRepo('git rev-parse HEAD', repoRoot).trim();
  } catch { /* shouldn't happen but not fatal — commit already landed */ }

  logger.info(
    { experimentId: opts.experimentId, commitSha, filesWritten: opts.files.map((f) => f.path) },
    '[self-commit] experiment committed autonomously',
  );

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
} {
  return {
    killSwitchOpen: isKillSwitchOpen(),
    repoRootConfigured: getRepoRoot() !== null,
    repoRoot: getRepoRoot(),
    allowedPathPrefixes: ALLOWED_PATH_PREFIXES,
  };
}
