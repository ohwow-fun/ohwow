/* eslint-disable no-console -- this module is an interactive CLI entry
 * point, not a daemon code path. Every console.log below is intentional
 * user-facing output written to stdout. The project-wide no-console
 * rule exists to keep the daemon's structured pino logs clean; CLI
 * UX is the one legitimate exception.
 */

/**
 * `ohwow chrome bootstrap` — one-time, user-driven, explicit-consent
 * setup of the debug Chrome data dir at `~/.ohwow/chrome-debug/`.
 *
 * Runtime code NEVER calls this. It's an explicit CLI action a user
 * invokes when they want to import their real Chrome profiles into
 * ohwow's independent debug Chrome workspace. Once bootstrapped, the
 * runtime treats the debug dir as a standalone Chrome install and
 * never touches its files again (see chrome-lifecycle.ts for the
 * full runtime discipline).
 *
 * What this does and why the order matters:
 *
 *   1. Detect whether real Chrome is running. If so, offer to quit
 *      it. If the user declines, abort — we refuse to clone a live
 *      Chrome user-data-dir, because that was the root cause of the
 *      "signed out but cookies kept" hybrid-state bug.
 *
 *   2. Graceful osascript quit: `tell application "Google Chrome"
 *      to quit`. Waits for the process to exit cleanly.
 *
 *   3. Hard quit fallback: if osascript doesn't get Chrome down in
 *      5s, escalate to SIGTERM on every `/Google Chrome.app/.../Chrome`
 *      PID we can pgrep, filtering out helper subprocesses.
 *
 *   4. Settle pause: Chrome's on-disk files (Preferences, Local
 *      State, Cookies SQLite WAL) need ~500ms after the process
 *      exits before they're fully flushed. Skipping this pause
 *      is the original launch-eve bug — the clone race happens
 *      inside this window.
 *
 *   5. Clone the real Chrome user-data-dir via `cp -cR` (APFS
 *      clonefile, near-instant + near-zero disk) with fallback to
 *      `cp -R` on non-APFS volumes. Destination is wiped first
 *      if it already exists (bootstrap semantics are "start clean").
 *
 *   6. Verify the result by reading the cloned `Local State` via
 *      `describeDebugChromeState()`. If the state comes back
 *      `ready`, list the imported profiles back to the user. If
 *      `corrupted`, roll back: move the half-cloned dir to
 *      `~/.ohwow/chrome-debug.failed-<timestamp>/` for forensic
 *      inspection and report the detected issues.
 *
 *   7. Do NOT restart Chrome. Let the user open their Chrome again
 *      on their schedule — the debug dir is fully decoupled from
 *      real Chrome now and the two run concurrently from here on.
 *
 * The function is designed to be called from an interactive shell
 * (TTY). When stdin is not a TTY it defaults to `--yes` mode for
 * scripted use, and the caller is responsible for its own consent.
 */

import { exec, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rename, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { logger } from '../../lib/logger.js';
import {
  DEBUG_DATA_DIR,
  describeDebugChromeState,
  type ProfileInfo,
} from './chrome-lifecycle.js';

// ---------------------------------------------------------------------------
// Platform-specific real Chrome paths
// ---------------------------------------------------------------------------

function realChromeDataDir(): string {
  const home = homedir();
  switch (process.platform) {
    case 'darwin': return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    case 'win32': return join(process.env.LOCALAPPDATA || home, 'Google', 'Chrome', 'User Data');
    default: return join(home, '.config', 'google-chrome');
  }
}

// ---------------------------------------------------------------------------
// Exec helper
// ---------------------------------------------------------------------------

interface ExecResult { stdout: string; stderr: string; code: number }

function execCapture(cmd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout, stderr) => {
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Real Chrome detection + quit
// ---------------------------------------------------------------------------

/**
 * Find PIDs for the main Chrome process (not helper/renderer
 * subprocesses) that's running against the REAL Chrome user-data-dir.
 * Skips Stagehand / Playwright / ohwow's own debug Chrome.
 */
async function findRealChromePids(): Promise<number[]> {
  if (process.platform === 'win32') return [];
  const pgrepCmd = process.platform === 'darwin'
    ? 'pgrep -f "Google Chrome.app/Contents/MacOS/Google Chrome"'
    : 'pgrep -f "google-chrome|/chrome "';
  const { stdout } = await execCapture(pgrepCmd);
  const pids = stdout.trim().split('\n').map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
  const real: number[] = [];
  for (const pid of pids) {
    const { stdout: psOut } = await execCapture(`ps -o command= -p ${pid}`);
    const cmd = psOut.trim();
    if (!cmd) continue;
    if (/--type=/.test(cmd)) continue; // helper/renderer
    const dirMatch = cmd.match(/--user-data-dir=([^ ]+)/);
    const dataDir = dirMatch ? dirMatch[1] : '';
    // No --user-data-dir = default data-dir = real Chrome.
    // Explicit match against the real Chrome dir path = real Chrome.
    // Anything else (debug, stagehand, ms-playwright, /tmp, /var) is skipped.
    if (!dataDir) { real.push(pid); continue; }
    if (dataDir === realChromeDataDir()) { real.push(pid); continue; }
  }
  return real;
}

async function quitRealChromeGracefully(): Promise<void> {
  if (process.platform === 'darwin') {
    await execCapture(`osascript -e 'tell application "Google Chrome" to quit'`);
  } else if (process.platform === 'win32') {
    await execCapture('taskkill /IM chrome.exe');
  } else {
    const pids = await findRealChromePids();
    if (pids.length > 0) await execCapture(`kill -TERM ${pids.join(' ')}`);
  }
}

async function waitForRealChromeExit(maxMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxMs) {
    const pids = await findRealChromePids();
    if (pids.length === 0) return true;
    await sleep(250);
  }
  return false;
}

async function forceKillRealChrome(): Promise<void> {
  const pids = await findRealChromePids();
  if (pids.length === 0) return;
  if (process.platform === 'win32') {
    await execCapture('taskkill /F /IM chrome.exe');
  } else {
    await execCapture(`kill -KILL ${pids.join(' ')}`);
  }
}

// ---------------------------------------------------------------------------
// Clonefile copy with cp -R fallback
// ---------------------------------------------------------------------------

async function cloneDataDir(source: string, dest: string): Promise<void> {
  // Wipe the destination. Bootstrap semantics = clean import.
  if (existsSync(dest)) {
    await rm(dest, { recursive: true, force: true });
  }
  await mkdir(dirname(dest), { recursive: true });

  // Stringify both paths via JSON so any unusual characters
  // (spaces, apostrophes) survive shell interpolation cleanly.
  const safeSource = JSON.stringify(source);
  const safeDest = JSON.stringify(dest);

  // Try clonefile first — APFS copy-on-write, near-instant + zero disk.
  const clone = await execCapture(`cp -cR ${safeSource} ${safeDest}`);
  if (clone.code === 0) return;

  logger.warn(
    { err: clone.stderr.slice(0, 200) },
    '[chrome-bootstrap] cp -c (clonefile) failed, falling back to cp -R',
  );
  // Re-wipe in case the partial clone left artifacts.
  await rm(dest, { recursive: true, force: true });
  const fallback = await execCapture(`cp -R ${safeSource} ${safeDest}`);
  if (fallback.code !== 0) {
    throw new Error(`cp -R failed: ${fallback.stderr.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Prompt helper (TTY-aware)
// ---------------------------------------------------------------------------

async function confirmInteractive(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Non-interactive shell (piped, CI, etc). Defer to the caller's
    // --yes flag handling, which runs before we get here.
    return true;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question} [y/N] `, (ans) => resolve(ans.trim().toLowerCase()));
    });
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface BootstrapOptions {
  /** Skip interactive confirmation prompts. Default false. */
  yes?: boolean;
  /** Print diagnostic info and do nothing. Default false. */
  dryRun?: boolean;
}

export interface BootstrapResult {
  ok: boolean;
  message: string;
  profilesImported?: ProfileInfo[];
  debugDataDir: string;
  failedBackupPath?: string;
}

/**
 * Run the full bootstrap flow. Prints status to stdout as it
 * progresses. Returns a structured result the CLI caller can format.
 */
export async function runChromeBootstrap(opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  const yes = !!opts.yes;
  const dryRun = !!opts.dryRun;
  const realDataDir = realChromeDataDir();
  const result: BootstrapResult = { ok: false, message: '', debugDataDir: DEBUG_DATA_DIR };

  console.log('');
  console.log('ohwow chrome bootstrap');
  console.log('');
  console.log(`  real Chrome data dir:  ${realDataDir}`);
  console.log(`  debug Chrome dir:      ${DEBUG_DATA_DIR}`);
  console.log('');

  // Pre-check: current state of the debug dir.
  const beforeState = describeDebugChromeState();
  if (beforeState.status === 'ready') {
    console.log(`Debug Chrome dir is already populated (${beforeState.profileCount} profiles).`);
    console.log('This command will WIPE it and re-import from your real Chrome.');
    console.log('');
    if (!yes && !(await confirmInteractive('Proceed with a clean re-import?'))) {
      result.message = 'Bootstrap cancelled by user (existing debug dir kept).';
      console.log(result.message);
      return result;
    }
  } else if (beforeState.status === 'corrupted') {
    console.log('Debug Chrome dir exists but is broken:');
    for (const issue of beforeState.detectedIssues) {
      console.log(`  - ${issue}`);
    }
    console.log('Will replace it.');
    console.log('');
  } else {
    console.log('No debug Chrome dir yet (fresh install). Will create one.');
    console.log('');
  }

  // Real Chrome state check.
  if (!existsSync(realDataDir)) {
    result.message = `Real Chrome data dir not found at ${realDataDir}. Install Google Chrome and sign into at least one profile first, then re-run this command.`;
    console.log(result.message);
    return result;
  }

  const realPids = await findRealChromePids();
  console.log(`Real Chrome processes running: ${realPids.length > 0 ? realPids.join(', ') : '(none)'}`);
  if (realPids.length > 0) {
    console.log('');
    console.log('Real Chrome MUST be quit before cloning. A running Chrome writes to its data dir');
    console.log('and the clone would capture a mid-write snapshot, corrupting Google sign-in state.');
    console.log('');
    if (!yes && !(await confirmInteractive('Quit your real Chrome now?'))) {
      result.message = 'Bootstrap cancelled — real Chrome still running. Quit Chrome manually and re-run.';
      console.log(result.message);
      return result;
    }
    if (dryRun) {
      console.log('(dry-run) Would quit real Chrome here.');
    } else {
      console.log('Quitting real Chrome (graceful)...');
      await quitRealChromeGracefully();
      const gone = await waitForRealChromeExit(5000);
      if (!gone) {
        console.log('Real Chrome did not respond to graceful quit; sending SIGTERM.');
        await forceKillRealChrome();
        const goneAfterKill = await waitForRealChromeExit(5000);
        if (!goneAfterKill) {
          result.message = 'Failed to quit real Chrome after 10s (SIGTERM ignored). Aborting bootstrap to avoid cloning a live Chrome.';
          console.log(result.message);
          return result;
        }
      }
      console.log('Real Chrome quit.');
    }
  }

  // Settle pause — Chrome needs a moment to finish flushing Preferences,
  // Local State, and Cookies SQLite WAL to disk after the process exits.
  // Skipping this is the exact bug we're fixing. The pause is short
  // enough that users won't notice; the alternative is data corruption.
  if (!dryRun && realPids.length > 0) {
    console.log('Waiting 1s for Chrome files to settle on disk...');
    await sleep(1000);
  }

  // Clone step.
  if (dryRun) {
    console.log('(dry-run) Would clone:');
    console.log(`  source: ${realDataDir}`);
    console.log(`  dest:   ${DEBUG_DATA_DIR}`);
    result.ok = true;
    result.message = 'Dry-run complete. Rerun without --dry-run to actually import.';
    return result;
  }

  console.log('Cloning real Chrome data dir via clonefile...');
  const cloneStart = Date.now();
  try {
    await cloneDataDir(realDataDir, DEBUG_DATA_DIR);
  } catch (err) {
    result.message = `Clone failed: ${err instanceof Error ? err.message : String(err)}`;
    console.log(result.message);
    return result;
  }
  console.log(`Clone complete in ${Date.now() - cloneStart}ms.`);

  // Verify the clone landed cleanly.
  const afterState = describeDebugChromeState();
  if (afterState.status !== 'ready') {
    const backupPath = `${DEBUG_DATA_DIR}.failed-${Date.now()}`;
    console.log('Clone verification failed. Rolling back.');
    if (afterState.status === 'corrupted') {
      for (const issue of afterState.detectedIssues) {
        console.log(`  - ${issue}`);
      }
    }
    try {
      await rename(DEBUG_DATA_DIR, backupPath);
      console.log(`Moved the broken clone to ${backupPath} for inspection.`);
      result.failedBackupPath = backupPath;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, '[chrome-bootstrap] failed to backup broken clone');
    }
    result.message = 'Bootstrap verification failed; clone rolled back.';
    return result;
  }

  console.log('');
  console.log(`Verified. ${afterState.profileCount} profiles imported:`);
  for (const p of afterState.profiles) {
    const email = p.email ?? '(no Google sign-in)';
    const label = p.localProfileName ?? p.directory;
    console.log(`  - ${p.directory.padEnd(12)} ${label.padEnd(16)} ${email}`);
  }
  console.log('');
  console.log('ohwow chrome bootstrap done. You can reopen your real Chrome now; it runs');
  console.log('independently of the debug Chrome from here on. To refresh the debug dir');
  console.log('with your latest profiles later, run `ohwow chrome bootstrap` again.');
  console.log('');

  result.ok = true;
  result.message = `Imported ${afterState.profileCount} profiles into ${DEBUG_DATA_DIR}.`;
  result.profilesImported = afterState.profiles;
  return result;
}

// ---------------------------------------------------------------------------
// Small utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Allow callers outside the class to reach the spawn helper if they
// want to do their own pre-flight checks. Not currently used.
export { spawn };
