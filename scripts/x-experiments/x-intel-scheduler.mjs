/**
 * x-intel-scheduler.mjs — long-running loop that runs x-intel on an
 * interval. The right shape when you want the pipeline active in a
 * terminal tab and rely on the auto-apply / approval queue to keep
 * humans in the loop.
 *
 *   INTERVAL_MIN=180 npx tsx scripts/x-experiments/x-intel-scheduler.mjs
 *   OHWOW_WORKSPACE=default INTERVAL_MIN=120 npx tsx ... (bind to a workspace)
 *   CHAIN_X_COMPOSE=1 CHAIN_YT_COMPOSE=1 npx tsx ... (chain compose scripts after intel)
 *
 * For production, prefer the launchd plist at
 * scripts/x-experiments/com.ohwow.x-intel.plist.example which gives you
 * macOS-native scheduling, log rotation, and auto-restart on crash.
 *
 * Design notes:
 *   - Runs x-intel.mjs as a child process so a synthesis bug doesn't
 *     kill the whole loop. A non-zero exit code is logged and we wait
 *     for the next tick.
 *   - Sleeps between runs, not during — so a 135s run + 180min interval
 *     is 180min of sleep, not 180min+135s. Drift-free at this granularity.
 *   - Honors SIGINT / SIGTERM cleanly — don't orphan a tsx child.
 *   - Writes a heartbeat file at ~/.ohwow/workspaces/<ws>/x-intel-last-run.json
 *     so an external watchdog (or the dashboard) can see the last run's
 *     timestamp + exit code.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOhwow } from './_ohwow.mjs';

const INTERVAL_MIN = Number(process.env.INTERVAL_MIN || 180);
const SCRIPT = path.resolve('scripts/x-experiments/x-intel.mjs');
const { workspace } = resolveOhwow();
const heartbeatPath = path.join(os.homedir(), '.ohwow', 'workspaces', workspace, 'x-intel-last-run.json');

// Chain scripts: after x-intel, optionally run x-compose and yt-compose.
// Controlled by env vars (default: off until operator enables).
const CHAIN_X_COMPOSE = process.env.CHAIN_X_COMPOSE === '1';
const CHAIN_YT_COMPOSE = process.env.CHAIN_YT_COMPOSE === '1';
const X_COMPOSE_SCRIPT = path.resolve('scripts/x-experiments/x-compose.mjs');
const YT_COMPOSE_SCRIPT = path.resolve('scripts/x-experiments/yt-compose.mjs');

let child = null;
let stopping = false;

function handleSignal(sig) {
  console.log(`\n[scheduler] ${sig} — stopping after current run`);
  stopping = true;
  if (child) child.kill('SIGTERM');
}
process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

function runScript(scriptPath, label) {
  return new Promise((resolve) => {
    const start = Date.now();
    console.log(`\n[scheduler] [${new Date().toISOString()}] launching ${label} for workspace=${workspace}`);
    child = spawn('npx', ['tsx', scriptPath], {
      env: process.env,
      stdio: 'inherit',
      cwd: path.resolve('.'),
    });
    child.on('exit', (code) => {
      const durationS = Math.round((Date.now() - start) / 1000);
      console.log(`[scheduler] ${label} exited code=${code} after ${durationS}s`);
      child = null;
      resolve(code);
    });
  });
}

async function runOnce() {
  const start = Date.now();
  const intelCode = await runScript(SCRIPT, 'x-intel');

  const record = {
    ts: new Date().toISOString(), workspace,
    exitCode: intelCode,
    durationS: Math.round((Date.now() - start) / 1000),
  };
  try { fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true }); fs.writeFileSync(heartbeatPath, JSON.stringify(record, null, 2)); } catch {}

  if (intelCode !== 0 || stopping) return intelCode;

  if (CHAIN_X_COMPOSE) {
    await runScript(X_COMPOSE_SCRIPT, 'x-compose');
    if (stopping) return 0;
  }

  if (CHAIN_YT_COMPOSE) {
    await runScript(YT_COMPOSE_SCRIPT, 'yt-compose');
  }

  return intelCode;
}

const chains = [CHAIN_X_COMPOSE && 'x-compose', CHAIN_YT_COMPOSE && 'yt-compose'].filter(Boolean);
console.log(`[scheduler] workspace=${workspace} · interval=${INTERVAL_MIN}min · chain=[${chains.join(', ') || 'none'}]`);
console.log(`[scheduler] ^C to stop after the current run`);

while (!stopping) {
  await runOnce();
  if (stopping) break;
  const nextAt = new Date(Date.now() + INTERVAL_MIN * 60_000).toISOString();
  console.log(`[scheduler] sleeping ${INTERVAL_MIN}min — next run ${nextAt}`);
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, INTERVAL_MIN * 60_000);
    const onSig = () => { clearTimeout(timer); resolve(); };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  });
}
console.log('[scheduler] stopped');
