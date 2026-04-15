/**
 * Layer 5a of the autonomous-fixing safety floor — cool-off revert
 * primitives.
 *
 * When an autonomous patch lands (carrying a Fixes-Finding-Id trailer
 * per Layer 2), it enters a cool-off window. If the justifying finding
 * re-fires with verdict in {warning, fail} during that window, the
 * patch didn't fix the problem and should be reverted. This module
 * provides the two primitives the rollback experiment composes:
 *
 *   - findAutonomousPatchesInWindow: discover eligible patches
 *   - revertCommit: git-revert one of them
 *
 * The actual policy (when to revert, based on which findings re-fired)
 * lives in the experiment wrapper (Layer 5b), not here.
 *
 * Kill switch
 * -----------
 * revertCommit is gated by a separate kill-switch file
 * (~/.ohwow/auto-revert-enabled). The operator opts in explicitly;
 * default is closed. A revert is a mutation of main just like a
 * self-commit, so it gets the same opt-in primitive.
 *
 * No --no-verify
 * --------------
 * `git revert` runs husky's pre-commit hook. The hook typechecks the
 * post-revert tree — if reverting would break the build, the revert
 * is refused and the bad commit stays on main until a human fixes it.
 * That's a correct outcome: auto-revert is a heal-ourselves shortcut,
 * not a push-broken-code-to-main shortcut.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { logger } from '../lib/logger.js';

export interface AutonomousPatch {
  /** Commit sha. */
  sha: string;
  /** Value of the Fixes-Finding-Id: trailer — the justifying finding's uuid. */
  findingId: string;
  /**
   * Commit author timestamp as ISO string, normalized to UTC Z-form
   * (e.g. 2026-04-15T02:26:01Z). Callers rely on lexicographic
   * comparison against self_findings.ran_at (which is stored in
   * Z-form) so we MUST normalize away the local offset that git's
   * %aI emits — otherwise a commit at 21:26 -05:00 string-compares
   * greater than a finding at 22:00Z the same UTC day.
   */
  ts: string;
  /** Files touched by the commit (relative to repo root). */
  files: string[];
  /** The experimentId trailer (author of the patch), if present. */
  experimentId: string | null;
}

/**
 * Normalize a git %aI timestamp (which carries a local offset like
 * `-05:00`) to UTC Z-form. Throws on invalid input — upstream callers
 * already filter records without a parsable ts, so a throw here means
 * git gave us something unexpected and we want to know.
 */
export function normalizeCommitTsToUtc(ts: string): string {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) {
    throw new Error(`unparseable commit timestamp: ${ts}`);
  }
  return new Date(ms).toISOString();
}

/**
 * Revert-kill-switch file. Exists only when the operator has opted in
 * to automatic reverts. Missing file = refusal. Distinct from the
 * safeSelfCommit kill switch so the operator can enable authoring
 * without enabling reverts (and vice versa).
 */
export const AUTO_REVERT_ENABLED_PATH = path.join(
  os.homedir(),
  '.ohwow',
  'auto-revert-enabled',
);

/** Test-only env var that bypasses the kill-switch file check. */
const TEST_BYPASS_ENV = 'OHWOW_AUTO_REVERT_TEST_ALLOW';

function isRevertKillSwitchOpen(): boolean {
  if (process.env[TEST_BYPASS_ENV] === '1') return true;
  try {
    return fs.existsSync(AUTO_REVERT_ENABLED_PATH);
  } catch {
    return false;
  }
}

function run(command: string, cwd: string, input?: string): string {
  return execSync(command, {
    cwd,
    stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : 'pipe',
    input,
    timeout: 60_000,
    encoding: 'utf-8',
  }).toString();
}

/**
 * Enumerate autonomous patches on the current branch whose commit
 * time is within `windowMs` of now AND which carry a Fixes-Finding-Id
 * trailer. Pure read — safe to call on a hot repo without a lock.
 */
export function findAutonomousPatchesInWindow(
  repoRoot: string,
  windowMs: number,
): AutonomousPatch[] {
  const sinceSeconds = Math.ceil(windowMs / 1000);
  // %H sha, %aI author-date ISO, %B raw body. Null-terminate records
  // so commit bodies containing newlines don't collide with the
  // outer delimiter.
  let out: string;
  try {
    out = run(
      `git log --since=${sinceSeconds}.seconds.ago --pretty=format:%H%x1f%aI%x1f%B%x1e`,
      repoRoot,
    );
  } catch {
    return [];
  }
  const records = out.split('\x1e').map((r) => r.trim()).filter((r) => r.length > 0);
  // First pass: collect shas that have already been reverted. The
  // revert commit carries `Auto-Reverts: <sha>`; anything named
  // there must be skipped even if the original commit is still in
  // the window, otherwise the watcher tries to revert it over and
  // over and each `git revert` on an already-reverted commit leaves
  // conflict markers in the tree.
  const alreadyReverted = new Set<string>();
  for (const rec of records) {
    const parts = rec.split('\x1f');
    const body = parts[2] ?? '';
    const m = body.match(/^Auto-Reverts:\s*([0-9a-f]{7,40})\s*$/m);
    if (m && m[1]) alreadyReverted.add(m[1]);
  }
  const patches: AutonomousPatch[] = [];
  for (const rec of records) {
    const [sha, ts, body] = rec.split('\x1f');
    if (!sha || !ts || !body) continue;
    if (alreadyReverted.has(sha)) continue;
    // Match by prefix too — revert trailers may carry a short sha.
    let shortHit = false;
    for (const short of alreadyReverted) {
      if (sha.startsWith(short)) { shortHit = true; break; }
    }
    if (shortHit) continue;
    const findingMatch = body.match(/^Fixes-Finding-Id:\s*([^\s]+)\s*$/m);
    if (!findingMatch) continue;
    const findingId = findingMatch[1];
    const expMatch = body.match(/^Self-authored by experiment:\s*(\S+)\s*$/m);
    const experimentId = expMatch ? expMatch[1] : null;
    let files: string[] = [];
    try {
      const filesOut = run(`git show --name-only --pretty=format: ${sha}`, repoRoot);
      files = filesOut.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
    } catch {
      files = [];
    }
    let tsUtc: string;
    try {
      tsUtc = normalizeCommitTsToUtc(ts);
    } catch {
      continue;
    }
    patches.push({ sha, findingId, ts: tsUtc, files, experimentId });
  }
  return patches;
}

export interface RevertResult {
  ok: boolean;
  reason?: string;
  /** SHA of the revert commit. */
  revertSha?: string;
}

/**
 * Revert one autonomous patch and push. Kill-switch-gated: without
 * ~/.ohwow/auto-revert-enabled the call refuses immediately. The
 * revert commit carries a trailer block recording which sha was
 * reverted and why so operators can trace the heal-cycle from the
 * ledger.
 *
 * Push is best-effort — revert-local + push-later is still a healed
 * state on the next push cycle. But unlike safeSelfCommit we DO
 * return ok: false on push failure; a local-only revert leaves main
 * inconsistent with origin and future autonomous commits would
 * diverge.
 */
export function revertCommit(
  repoRoot: string,
  sha: string,
  reason: string,
): RevertResult {
  if (!isRevertKillSwitchOpen()) {
    return {
      ok: false,
      reason: `auto-revert is disabled by default. To enable, create ${AUTO_REVERT_ENABLED_PATH}`,
    };
  }
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    return { ok: false, reason: `invalid sha: ${sha}` };
  }
  if (reason.length < 10) {
    return { ok: false, reason: 'revert reason must be at least 10 characters' };
  }

  const message =
    `revert: autonomous patch ${sha.slice(0, 12)} rolled back by Layer 5\n\n` +
    `${reason}\n\n` +
    `Auto-Reverts: ${sha}\n`;
  try {
    run(`git revert -s --no-edit ${sha}`, repoRoot);
    // Overwrite the default revert message with our annotated one.
    // --no-edit above committed with git's autogen message; amend in
    // place to add the trailer. We permit amend here because the
    // revert commit is brand-new and unpushed at this point.
    run(`git commit --amend -s -F -`, repoRoot, message);
  } catch (err) {
    // `git revert` can fail mid-operation (e.g. the commit is already
    // reverted and produces an empty diff, or there's a conflict).
    // Without cleanup, git leaves the working tree in a conflicted
    // state with unresolved <<<<<<< markers — subsequent tool runs
    // (and other patch-author ticks) will fail to parse those files.
    // Always run `git revert --abort` so a failed revert leaves no
    // trace. Best-effort: if the abort itself fails, there was
    // nothing to abort, which is fine.
    try { run('git revert --abort', repoRoot); } catch { /* best effort */ }
    return { ok: false, reason: `git revert failed: ${extractErrorSummary(err)}` };
  }

  let revertSha: string | undefined;
  try {
    revertSha = run('git rev-parse HEAD', repoRoot).trim();
  } catch { /* non-fatal */ }

  try {
    run('git push', repoRoot);
  } catch (err) {
    logger.error(
      { sha, revertSha, err: extractErrorSummary(err) },
      '[auto-revert] revert committed locally but push failed — main is ahead of origin',
    );
    return {
      ok: false,
      reason: `revert committed as ${revertSha} but push failed: ${extractErrorSummary(err)}`,
      revertSha,
    };
  }

  logger.info(
    { revertedSha: sha, revertSha, reason },
    '[auto-revert] autonomous patch rolled back and pushed',
  );
  return { ok: true, revertSha };
}

function extractErrorSummary(err: unknown): string {
  if (err instanceof Error) {
    const maybeStderr = (err as { stderr?: Buffer | string }).stderr;
    if (maybeStderr) {
      const s = typeof maybeStderr === 'string' ? maybeStderr : maybeStderr.toString('utf-8');
      if (s.trim()) return s.slice(0, 500);
    }
    return err.message.slice(0, 500);
  }
  return String(err).slice(0, 500);
}
