#!/usr/bin/env node
/**
 * ohwow bench harness — gap 09 slice 1.
 *
 * Wraps ONE benchmarked task against a running local daemon, snapshots pulse
 * / approvals / tasks before and after, diffs the pulse window, and writes a
 * BenchRun JSON plus a one-line summary to scripts/bench/results/.
 *
 * Usage: node scripts/bench/run.mjs <task-id> [flags]
 * See ./README.md for flag details and current limitations.
 */

import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import {
  snapshotPulse,
  snapshotApprovals,
  snapshotTasks,
  diffPulse,
  pollTaskUntilTerminal,
} from './lib/collectors.mjs';

/**
 * Resolve the daemon bearer token from (in order):
 *   1. OHWOW_TOKEN env var.
 *   2. ~/.ohwow/workspaces/<active>/daemon.token.
 *   3. null — caller decides whether to proceed or surface the 401.
 *
 * "<active>" picks up OHWOW_WORKSPACE then the ~/.ohwow/current-workspace
 * pointer, defaulting to `default`. Mirrors scripts/x-experiments/_ohwow.mjs
 * so behaviour is consistent across local tooling.
 */
function resolveDaemonToken() {
  if (process.env.OHWOW_TOKEN) return process.env.OHWOW_TOKEN;
  try {
    const ws =
      process.env.OHWOW_WORKSPACE ||
      readFileSync(path.join(os.homedir(), '.ohwow', 'current-workspace'), 'utf8').trim() ||
      'default';
    const tokenPath = path.join(os.homedir(), '.ohwow', 'workspaces', ws, 'daemon.token');
    return readFileSync(tokenPath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(SCRIPT_DIR, 'results');

const HELP = `
ohwow bench — one-shot local benchmark harness

Usage:
  node scripts/bench/run.mjs <task-id> [options]

Arguments:
  <task-id>               Bench unit to run. Available: research-to-commit

Options:
  --dry-run               Skip dispatch; only probe /api/pulse for readiness
                          and emit a BenchRun with zeroed metrics.
  --port=<n>              Daemon port. Default: env OHWOW_DAEMON_PORT or 7700.
  --timeout-ms=<n>        Max time to wait for the task to reach terminal
                          status. Default: 600000 (10 minutes).
  --agent-id=<id>         Skip the task module's agent discovery and use this
                          agent id directly. Useful when the daemon has no
                          clearly-tagged coding agent.
  --help, -h              Show this help and exit.
`;

function parseArgs(argv) {
  const args = {
    taskId: null,
    dryRun: false,
    port: Number(process.env.OHWOW_DAEMON_PORT) || 7700,
    timeoutMs: 600_000,
    agentId: null,
    help: false,
  };
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') {
      args.help = true;
      continue;
    }
    if (raw === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (raw.startsWith('--port=')) {
      args.port = Number(raw.slice('--port='.length)) || args.port;
      continue;
    }
    if (raw.startsWith('--timeout-ms=')) {
      args.timeoutMs = Number(raw.slice('--timeout-ms='.length)) || args.timeoutMs;
      continue;
    }
    if (raw.startsWith('--agent-id=')) {
      args.agentId = raw.slice('--agent-id='.length) || null;
      continue;
    }
    if (raw.startsWith('--')) {
      throw new Error(`Unknown flag: ${raw}`);
    }
    if (!args.taskId) {
      args.taskId = raw;
      continue;
    }
    throw new Error(`Unexpected positional argument: ${raw}`);
  }
  return args;
}

async function loadTaskModule(taskId) {
  const mod = await import(`./tasks/${taskId}.mjs`).catch((err) => {
    throw new Error(
      `Unknown bench task "${taskId}". Tried scripts/bench/tasks/${taskId}.mjs (${err?.code ?? err?.message ?? 'load failed'}).`,
    );
  });
  if (typeof mod?.run !== 'function') {
    throw new Error(`Task module ${taskId}.mjs must export an async run(ctx) function.`);
  }
  return mod;
}

async function probePulse(port, token) {
  const res = await fetch(`http://localhost:${port}/api/pulse`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    throw new Error(
      `Daemon at :${port} /api/pulse returned HTTP ${res.status}.` +
        (res.status === 401
          ? ' Missing or invalid OHWOW_TOKEN / ~/.ohwow/workspaces/<ws>/daemon.token.'
          : ' Is it running?'),
    );
  }
  return res.json();
}

function ensureIsoForFilename(iso) {
  // Filesystem-safe: strip colons, keep millis + Z.
  return iso.replace(/:/g, '-');
}

async function writeResults(benchRun) {
  await mkdir(RESULTS_DIR, { recursive: true });
  const filename = `${ensureIsoForFilename(benchRun.startedAt)}-${benchRun.taskId}.json`;
  const fullPath = path.join(RESULTS_DIR, filename);
  await writeFile(fullPath, JSON.stringify(benchRun, null, 2) + '\n', 'utf8');
  const summary = {
    bench_run_id: benchRun.benchRunId,
    task_id: benchRun.taskId,
    started_at: benchRun.startedAt,
    ended_at: benchRun.endedAt,
    duration_ms: benchRun.durationMs,
    status: benchRun.status,
    dry_run: benchRun.dryRun,
    tokens_total: benchRun.metrics?.tokens?.total ?? 0,
    cost_cents: benchRun.metrics?.cost_cents ?? 0,
    llm_calls: benchRun.metrics?.llm_calls ?? 0,
    result_path: fullPath,
  };
  await appendFile(path.join(RESULTS_DIR, 'index.jsonl'), JSON.stringify(summary) + '\n', 'utf8');
  return fullPath;
}

/**
 * Build the BenchRun shape. QA round will flesh out missing fields (wall
 * clock breakdown, approvals-created filter, etc); anything we can't fill
 * today lands in `notes` so QA has a concrete checklist.
 */
function buildBenchRun(partial) {
  return {
    benchRunId: partial.benchRunId,
    taskId: partial.taskId,
    taskLabel: partial.taskLabel,
    dryRun: partial.dryRun,
    startedAt: partial.startedAt,
    endedAt: partial.endedAt,
    durationMs: partial.endedAt && partial.startedAt
      ? new Date(partial.endedAt).getTime() - new Date(partial.startedAt).getTime()
      : 0,
    status: partial.status,
    agent: partial.agent ?? null,
    daemon: { port: partial.port },
    snapshots: partial.snapshots ?? {
      pulse: { before: null, after: null },
      approvals: { before: null, after: null },
      tasks: { pendingBefore: null, pendingAfter: null },
    },
    task: partial.task ?? null,
    metrics: partial.metrics ?? {
      tokens: { prompt: 0, completion: 0, total: 0 },
      cost_cents: 0,
      llm_calls: 0,
      model_used: [],
      approvals_delta: 0,
    },
    error: partial.error ?? null,
    notes: partial.notes ?? [],
  };
}

// scripts/ are not linted by eslint.config.mjs (no scripts/** glob). console
// output is the intended surface here — other scripts in this directory do
// the same (see autonomous-push.mjs, check-push-content.mjs).
// eslint-disable-next-line no-console
const log = (...args) => console.log(...args);
// eslint-disable-next-line no-console
const warn = (...args) => console.warn(...args);

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    warn(HELP);
    process.exit(2);
  }

  if (args.help) {
    log(HELP);
    process.exit(0);
  }

  if (!args.taskId) {
    warn('Missing <task-id>. Pass `research-to-commit` or run with --help.');
    process.exit(2);
  }

  const benchRunId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const notes = [];
  const token = resolveDaemonToken();

  const taskModule = await loadTaskModule(args.taskId);

  // ---- Dry-run path: readiness probe only ----
  if (args.dryRun) {
    let daemonUp = false;
    let pulseErr = null;
    try {
      await probePulse(args.port, token);
      daemonUp = true;
    } catch (err) {
      pulseErr = err instanceof Error ? err.message : String(err);
    }

    const endedAt = new Date().toISOString();
    const benchRun = buildBenchRun({
      benchRunId,
      taskId: args.taskId,
      taskLabel: taskModule.label ?? args.taskId,
      dryRun: true,
      startedAt,
      endedAt,
      status: daemonUp ? 'dry_run_ok' : 'dry_run_daemon_unreachable',
      port: args.port,
      agent: { resolved: null, source: 'skipped:dry-run' },
      metrics: {
        tokens: { prompt: 0, completion: 0, total: 0 },
        cost_cents: 0,
        llm_calls: 0,
        model_used: [],
        approvals_delta: 0,
      },
      task: { daemon_task_id: null, terminal_status: null },
      error: pulseErr,
      notes: [
        'dry-run: no /api/tasks dispatch, no snapshots beyond readiness probe.',
        'metrics.tokens.prompt and .completion are zero — pulse only exposes combined tokens today.',
        'model_used is empty because topModels was not sampled.',
        ...(pulseErr ? [`readiness probe failed: ${pulseErr}`] : []),
      ],
    });

    const fullPath = await writeResults(benchRun);
    log(JSON.stringify(benchRun, null, 2));
    log(`[bench] wrote ${fullPath}`);
    process.exit(daemonUp ? 0 : 1);
  }

  // ---- Live path ----
  let benchRun;
  try {
    const pulseBefore = await snapshotPulse(args.port, token);
    const approvalsBefore = await snapshotApprovals(args.port, token);
    const tasksPendingBefore = await snapshotTasks(args.port, 'pending', token);

    const { daemonTaskId, agentId, agentSource } = await taskModule.run({
      port: args.port,
      benchRunId,
      agentIdOverride: args.agentId,
      logger: { log, warn },
      token,
    });

    const { status: terminalStatus, task } = await pollTaskUntilTerminal(
      args.port,
      daemonTaskId,
      { timeoutMs: args.timeoutMs, intervalMs: 2000, token },
    );

    const pulseAfter = await snapshotPulse(args.port, token);
    const approvalsAfter = await snapshotApprovals(args.port, token);
    const tasksPendingAfter = await snapshotTasks(args.port, 'pending', token);
    const diff = diffPulse(pulseBefore, pulseAfter);

    const endedAt = new Date().toISOString();
    benchRun = buildBenchRun({
      benchRunId,
      taskId: args.taskId,
      taskLabel: taskModule.label ?? args.taskId,
      dryRun: false,
      startedAt,
      endedAt,
      status: terminalStatus,
      port: args.port,
      agent: { resolved: agentId, source: agentSource },
      snapshots: {
        pulse: { before: pulseBefore, after: pulseAfter },
        approvals: {
          before: { count: approvalsBefore.rows.length, timestamp: approvalsBefore.timestamp },
          after: { count: approvalsAfter.rows.length, timestamp: approvalsAfter.timestamp },
        },
        tasks: {
          pendingBefore: tasksPendingBefore.length,
          pendingAfter: tasksPendingAfter.length,
        },
      },
      task: { daemon_task_id: daemonTaskId, terminal_status: terminalStatus, row: task ?? null },
      metrics: {
        tokens: diff.tokens,
        cost_cents: diff.cost_cents,
        llm_calls: diff.llm_calls,
        model_used: diff.model_used,
        approvals_delta: approvalsAfter.rows.length - approvalsBefore.rows.length,
      },
      notes: [
        'pulse.llm.h24 is a 24h rolling window; if a background scheduler burned calls concurrently, metrics.llm_calls includes them too. Runtime patch to filter by bench_run_id is deferred.',
        'metrics.tokens.prompt/.completion stay 0 until pulse exposes split tokens.',
        ...notes,
      ],
    });
  } catch (err) {
    const endedAt = new Date().toISOString();
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    benchRun = buildBenchRun({
      benchRunId,
      taskId: args.taskId,
      taskLabel: taskModule.label ?? args.taskId,
      dryRun: false,
      startedAt,
      endedAt,
      status: 'bench_error',
      port: args.port,
      error: msg,
      notes: ['bench harness crashed before a terminal status was observed'],
    });
  }

  const fullPath = await writeResults(benchRun);
  log(JSON.stringify(benchRun, null, 2));
  log(`[bench] wrote ${fullPath}`);
  process.exit(benchRun.status === 'completed' ? 0 : 1);
}

main().catch(async (err) => {
  warn('[bench] fatal:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
