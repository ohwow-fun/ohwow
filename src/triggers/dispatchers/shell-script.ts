/**
 * shell_script dispatcher: spawn a Node script (via `npx tsx`) with the
 * ohwow env contract pre-wired. Returns exit code + stdout tail so
 * callers (and the trigger watchdog via consecutive_failures) can
 * observe success/failure.
 *
 * Contract the spawned script expects:
 *   OHWOW_WORKSPACE — workspace slug (default: the currently-focused
 *                      workspace from resolveActiveWorkspace, override
 *                      via config.workspace_slug)
 *   OHWOW_PORT      — the daemon's HTTP port (forwarded from process.env)
 *   Any env keys in config.env are merged on top of both.
 *
 * Optional heartbeat: if config.heartbeat_filename is set, after the
 * run we write { ts, workspace, exitCode, durationMs, stdoutTail } to
 * <workspace dataDir>/<filename>. This preserves compatibility with
 * external monitors that watched the old hand-coded scheduler
 * heartbeats (x-intel-last-run.json etc.) so migrating an automation
 * in doesn't blind them.
 *
 * Designed to replace the XIntelScheduler family (x-intel, x-compose,
 * x-reply, x-authors-to-crm, x-forecast, x-humor) once the matching
 * automations are seeded. See src/daemon/scheduling.ts for the
 * hand-coded call sites this is meant to absorb.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import type { LocalTrigger } from '../../webhooks/ghl-types.js';
import { ShellScriptConfigSchema } from '../action-config-schemas.js';
import { resolveActiveWorkspace, workspaceLayoutFor } from '../../config.js';
import { logger } from '../../lib/logger.js';

const DEFAULT_TIMEOUT_SECONDS = 15 * 60;
const STDOUT_TAIL_BYTES = 2048;

export const shellScriptDispatcher: ActionDispatcher = {
  actionType: 'shell_script',

  async execute(
    rawConfig: Record<string, unknown>,
    _context: ExecutionContext,
    _deps: DispatcherDeps,
    trigger: LocalTrigger,
  ): Promise<ActionOutput> {
    const parsed = ShellScriptConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new Error(`shell_script: invalid config — ${parsed.error.message}`);
    }
    const config = parsed.data;

    const repoRoot = process.env.OHWOW_REPO_ROOT || process.cwd();
    const scriptPath = isAbsolute(config.script_path)
      ? config.script_path
      : resolvePath(repoRoot, config.script_path);

    const workspaceSlug = config.workspace_slug || resolveActiveWorkspace().name;
    const timeoutMs = (config.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

    const started = Date.now();
    const { exitCode, stdoutTail, timedOut } = await runScript({
      scriptPath,
      cwd: repoRoot,
      timeoutMs,
      env: {
        ...process.env,
        OHWOW_WORKSPACE: workspaceSlug,
        OHWOW_PORT: process.env.OHWOW_PORT ?? '',
        ...(config.env ?? {}),
      },
    });
    const durationMs = Date.now() - started;

    let heartbeatPath: string | null = null;
    if (config.heartbeat_filename) {
      try {
        const layout = workspaceLayoutFor(workspaceSlug);
        heartbeatPath = join(layout.dataDir, config.heartbeat_filename);
        mkdirSync(dirname(heartbeatPath), { recursive: true });
        writeFileSync(
          heartbeatPath,
          JSON.stringify(
            {
              ts: new Date().toISOString(),
              workspace: workspaceSlug,
              exitCode,
              durationMs,
              stdoutTail,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        logger.warn(
          { err, heartbeatName: config.heartbeat_filename, trigger: trigger.id },
          '[shell_script] heartbeat write failed',
        );
      }
    }

    const status: 'ok' | 'nonzero_exit' | 'timeout' = timedOut
      ? 'timeout'
      : exitCode === 0
        ? 'ok'
        : 'nonzero_exit';

    if (status !== 'ok') {
      // Throwing surfaces as a step failure to the action executor,
      // which feeds the trigger watchdog's consecutive_failures counter.
      throw new Error(
        `shell_script ${config.script_path} ${status} (exit=${exitCode}, ${durationMs}ms)`,
      );
    }

    return {
      script_path: config.script_path,
      exit_code: exitCode,
      duration_ms: durationMs,
      stdout_tail: stdoutTail,
      heartbeat_path: heartbeatPath,
      status,
    };
  },
};

function runScript(opts: {
  scriptPath: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number; stdoutTail: string; timedOut: boolean }> {
  return new Promise((resolveRun) => {
    const child = spawn('npx', ['tsx', opts.scriptPath], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      if (stdoutBuf.length > STDOUT_TAIL_BYTES * 2) {
        stdoutBuf = stdoutBuf.slice(-STDOUT_TAIL_BYTES * 2);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, opts.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      resolveRun({
        exitCode: -1,
        stdoutTail: `spawn error: ${String(err)}${stderrBuf.slice(-STDOUT_TAIL_BYTES)}`,
        timedOut: false,
      });
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timeoutHandle);
      const exitCode = code ?? (signal ? -1 : 0);
      const tail = (stdoutBuf + stderrBuf).slice(-STDOUT_TAIL_BYTES);
      resolveRun({ exitCode, stdoutTail: tail, timedOut });
    });
  });
}
