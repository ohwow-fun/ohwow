/**
 * log_tail executor.
 *
 * Constructs provider-CLI argv WITHOUT string interpolation, spawns
 * the CLI, caps output, and computes an error-density score over the
 * returned lines. All provider/target identifiers come from caller
 * input or env; nothing operator-specific is hardcoded.
 *
 * Missing-CLI and missing-credentials cases are returned as a
 * structured `{ ok: false, reason }` result so the daemon keeps
 * running on a fresh clone with no cloud setup.
 */

import { spawn } from 'node:child_process';
import { logger } from '../../lib/logger.js';
import {
  type LogTailService,
  LOG_TAIL_SERVICES,
} from './log-tail-tools.js';

export interface LogTailResult {
  content: string;
  is_error?: boolean;
}

export interface LogTailPayload {
  ok: boolean;
  service: LogTailService;
  target?: string;
  lines_returned: number;
  error_density: number;
  reason?: string;
  output?: string;
}

const MAX_LINES = 2000;
const DEFAULT_LINES = 200;
const OUTPUT_BYTE_CAP = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

const ERROR_LINE_RE = /error|fail|panic|fatal|exception|timeout|\b5\d{2}\b/i;

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  spawnError?: string;
}

interface Spawner {
  (cmd: string, argv: string[], opts?: { timeoutMs?: number }): Promise<SpawnResult>;
}

export interface BuildArgvResult {
  ok: boolean;
  cmd?: string;
  argv?: string[];
  target?: string;
  reason?: string;
}

/**
 * Build argv for a given service. Exposed so tests can validate
 * construction without actually spawning.
 */
export function buildLogTailArgv(
  service: LogTailService,
  target: string | undefined,
  lines: number,
  env: NodeJS.ProcessEnv = process.env,
): BuildArgvResult {
  const n = Math.max(1, Math.min(MAX_LINES, Math.floor(lines)));
  switch (service) {
    case 'supabase': {
      const ref = target || env.OHWOW_SUPABASE_PROJECT_REF;
      if (!ref) return { ok: false, reason: 'missing_target: supabase requires project ref (target or OHWOW_SUPABASE_PROJECT_REF)' };
      return { ok: true, cmd: 'supabase', argv: ['logs', '--project-ref', ref, '--limit', String(n)], target: ref };
    }
    case 'vercel': {
      const project = target || env.OHWOW_VERCEL_PROJECT;
      const argv = ['logs'];
      if (project) argv.push(project);
      argv.push('--number', String(n));
      return { ok: true, cmd: 'vercel', argv, target: project };
    }
    case 'fly': {
      const app = target || env.OHWOW_FLY_APP;
      if (!app) return { ok: false, reason: 'missing_target: fly requires app name (target or OHWOW_FLY_APP)' };
      return { ok: true, cmd: 'flyctl', argv: ['logs', '--app', app, '--no-tail'], target: app };
    }
    case 'modal': {
      const app = target || env.OHWOW_MODAL_APP;
      if (!app) return { ok: false, reason: 'missing_target: modal requires app name (target or OHWOW_MODAL_APP)' };
      return { ok: true, cmd: 'modal', argv: ['app', 'logs', app], target: app };
    }
  }
}

function computeErrorDensity(output: string): { lines: number; density: number } {
  const lines = output.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { lines: 0, density: 0 };
  const errorLines = lines.filter((l) => ERROR_LINE_RE.test(l)).length;
  return { lines: lines.length, density: errorLines / lines.length };
}

function defaultSpawner(cmd: string, argv: string[], opts?: { timeoutMs?: number }): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ stdout: '', stderr: '', exitCode: 127, spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let killed = false;
    let bytes = 0;

    const onChunk = (target: 'o' | 'e') => (c: Buffer) => {
      const s = c.toString('utf-8');
      bytes += s.length;
      if (bytes > OUTPUT_BYTE_CAP) {
        if (!killed) { killed = true; child.kill('SIGKILL'); }
        return;
      }
      if (target === 'o') stdout += s; else stderr += s;
    };
    child.stdout?.on('data', onChunk('o'));
    child.stderr?.on('data', onChunk('e'));

    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: killed ? 124 : (code ?? 1) });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: 127, spawnError: err.message });
    });
  });
}

export interface LogTailDeps {
  spawner?: Spawner;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run log_tail. Never throws — credential / CLI / arg issues come
 * back as structured JSON in the tool content so the model can read
 * and adapt.
 */
export async function executeLogTail(
  input: Record<string, unknown>,
  deps: LogTailDeps = {},
): Promise<LogTailResult> {
  const spawner = deps.spawner ?? defaultSpawner;
  const env = deps.env ?? process.env;
  const serviceRaw = typeof input.service === 'string' ? input.service : '';
  if (!LOG_TAIL_SERVICES.includes(serviceRaw as LogTailService)) {
    const payload: LogTailPayload = {
      ok: false,
      service: serviceRaw as LogTailService,
      lines_returned: 0,
      error_density: 0,
      reason: `invalid_service: must be one of ${LOG_TAIL_SERVICES.join(', ')}`,
    };
    return { content: JSON.stringify(payload), is_error: true };
  }
  const service = serviceRaw as LogTailService;
  const target = typeof input.target === 'string' && input.target.length > 0 ? input.target : undefined;
  const lines = typeof input.lines === 'number' && Number.isFinite(input.lines) ? input.lines : DEFAULT_LINES;

  const built = buildLogTailArgv(service, target, lines, env);
  if (!built.ok) {
    const payload: LogTailPayload = {
      ok: false,
      service,
      target,
      lines_returned: 0,
      error_density: 0,
      reason: built.reason,
    };
    logger.info({ tool: 'log_tail', service, ok: false, reason: built.reason }, 'log_tail skipped');
    return { content: JSON.stringify(payload) };
  }

  const spawnResult = await spawner(built.cmd!, built.argv!, { timeoutMs: DEFAULT_TIMEOUT_MS });

  if (spawnResult.spawnError || spawnResult.exitCode === 127) {
    const payload: LogTailPayload = {
      ok: false,
      service,
      target: built.target,
      lines_returned: 0,
      error_density: 0,
      reason: `cli_unavailable: ${built.cmd} not installed or not on PATH`,
    };
    logger.info({ tool: 'log_tail', service, ok: false, reason: 'cli_unavailable' }, 'log_tail skipped');
    return { content: JSON.stringify(payload) };
  }

  if (spawnResult.exitCode !== 0) {
    const combined = (spawnResult.stderr + spawnResult.stdout).trim();
    const reason = /login|auth|unauthor|credential|token/i.test(combined)
      ? 'missing_credentials'
      : `cli_exit_${spawnResult.exitCode}`;
    const payload: LogTailPayload = {
      ok: false,
      service,
      target: built.target,
      lines_returned: 0,
      error_density: 0,
      reason: `${reason}: ${combined.slice(0, 400)}`,
    };
    logger.info({ tool: 'log_tail', service, ok: false, reason, exit_code: spawnResult.exitCode }, 'log_tail cli failed');
    return { content: JSON.stringify(payload) };
  }

  const output = spawnResult.stdout;
  const { lines: linesReturned, density } = computeErrorDensity(output);
  const payload: LogTailPayload = {
    ok: true,
    service,
    target: built.target,
    lines_returned: linesReturned,
    error_density: Number(density.toFixed(4)),
    output: output.length > OUTPUT_BYTE_CAP
      ? output.slice(0, OUTPUT_BYTE_CAP) + `\n[truncated: output exceeded ${OUTPUT_BYTE_CAP} bytes]`
      : output,
  };
  logger.info(
    { tool: 'log_tail', service, target: built.target, lines_returned: linesReturned, error_density: payload.error_density },
    'log_tail completed',
  );
  return { content: JSON.stringify(payload) };
}

export { computeErrorDensity };
