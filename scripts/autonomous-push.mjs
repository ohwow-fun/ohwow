#!/usr/bin/env node
// Deterministic autonomous-push gate.
//
// Purpose: provide a single auditable path that future autonomous
// pipelines can use to push, with every safety check enforced up-front
// and nothing the LLM can bypass. The daemon's self-bench does not
// invoke `git push` today; this script is the opt-in primitive for
// when it wants to.
//
// Runs ALL of the following before pushing, each a fail-closed gate:
//   1. Opt-in kill switch must be present (~/.ohwow/auto-push-enabled).
//      Mirrors the patch-author-enabled pattern: default CLOSED.
//   2. No uncommitted changes in the working tree. Autonomous push of
//      a dirty tree has caused silent bundling bugs; refuse entirely.
//   3. Daily push budget not exceeded. Default 24, override via
//      OHWOW_AUTONOMOUS_PUSH_DAILY_BUDGET.
//   4. Pre-push content scanner (the same `check-push-content.mjs`
//      git hooks use) passes over every commit being pushed.
//   5. Remote is unchanged from the last fetch (--force-with-lease).
//
// Any failure → clear exit code + message. No partial push state.
//
// Usage:
//   scripts/autonomous-push.mjs [<remote>] [<branch>]
//   Defaults: remote=origin branch=current HEAD branch
//
// Logged to ~/.ohwow/autonomous-push.log for audit (append-only JSON lines).

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const KILL_SWITCH_PATH = join(homedir(), '.ohwow', 'auto-push-enabled');
const AUDIT_LOG = join(homedir(), '.ohwow', 'autonomous-push.log');
const DAILY_BUDGET = Number(process.env.OHWOW_AUTONOMOUS_PUSH_DAILY_BUDGET ?? '24');

function audit(entry) {
  try {
    mkdirSync(dirname(AUDIT_LOG), { recursive: true });
    appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* best effort */ }
}

function refuse(code, reason) {
  audit({ outcome: 'refused', code, reason });
  console.error(`[autonomous-push] refused (${code}): ${reason}`);
  process.exit(1);
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', cwd: REPO_ROOT, ...opts }).trim();
}

const remote = process.argv[2] ?? 'origin';
const branch = process.argv[3] ?? sh('git rev-parse --abbrev-ref HEAD');

// Gate 1: opt-in kill switch. Default CLOSED — absence means "don't push".
if (!existsSync(KILL_SWITCH_PATH)) {
  refuse('KILL_SWITCH_CLOSED', `${KILL_SWITCH_PATH} is missing. Autonomous push is opt-in; create the file to enable.`);
}

// Gate 2: clean working tree. Anything staged or unstaged → refuse.
// An autonomous process shouldn't be pushing across concurrent human work.
const dirty = sh('git status --porcelain');
if (dirty) {
  refuse('WORKING_TREE_DIRTY', `working tree has uncommitted changes. Push only on clean state.`);
}

// Gate 3: daily budget. Count autonomous pushes in the last 24h from
// the audit log (success outcomes only). Fail-closed on a stat error.
let countLast24h = 0;
try {
  if (existsSync(AUDIT_LOG)) {
    const lines = readFileSync(AUDIT_LOG, 'utf-8').split('\n').filter(Boolean);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row.outcome === 'pushed' && Date.parse(row.ts) >= cutoff) countLast24h++;
      } catch { /* skip malformed */ }
    }
  }
} catch (err) {
  refuse('AUDIT_LOG_READ_FAIL', `could not count push history: ${err instanceof Error ? err.message : err}`);
}
if (countLast24h >= DAILY_BUDGET) {
  refuse('DAILY_BUDGET_REACHED', `${countLast24h}/${DAILY_BUDGET} autonomous pushes in last 24h. Raise OHWOW_AUTONOMOUS_PUSH_DAILY_BUDGET to bypass.`);
}

// Gate 4: fetch remote state so --force-with-lease has a fresh baseline,
// then run the pre-push content scanner over the commits to be pushed.
try {
  sh(`git fetch ${remote} ${branch}`);
} catch (err) {
  refuse('FETCH_FAILED', `git fetch ${remote} ${branch} failed: ${err instanceof Error ? err.message : err}`);
}

const localSha = sh(`git rev-parse ${branch}`);
const remoteSha = sh(`git rev-parse ${remote}/${branch}`);
if (localSha === remoteSha) {
  audit({ outcome: 'noop', branch, sha: localSha });
  console.log('[autonomous-push] no-op: local matches remote.');
  process.exit(0);
}

// Feed the scanner the same stdin shape git's pre-push hook uses.
const scannerInput = `refs/heads/${branch} ${localSha} refs/heads/${branch} ${remoteSha}\n`;
const scanResult = spawnSync('node', [join(SCRIPT_DIR, 'check-push-content.mjs')], {
  input: scannerInput,
  cwd: REPO_ROOT,
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (scanResult.status !== 0) {
  refuse('CONTENT_SCANNER_REJECTED', `pre-push content scanner blocked (exit ${scanResult.status}).`);
}

// Gate 5: push with --force-with-lease so a concurrent push from
// another authority (your manual push, a parallel session) aborts us
// safely rather than overwriting.
try {
  const pushOut = sh(`git push --force-with-lease ${remote} ${branch}`);
  audit({ outcome: 'pushed', branch, localSha, remoteSha, pushedOver: remoteSha });
  console.log(`[autonomous-push] pushed ${localSha.slice(0, 8)} → ${remote}/${branch}`);
  if (pushOut) console.log(pushOut);
} catch (err) {
  refuse('PUSH_FAILED', `git push failed: ${err instanceof Error ? err.message : err}`);
}
