/**
 * XIntelScheduler — runs the workspace's X intelligence pipeline
 * (scripts/x-experiments/x-intel.mjs) on a configured cadence.
 *
 * Lives alongside ContentCadenceScheduler and ImprovementScheduler: an
 * outbound action scheduler, not a probe/judge/intervene experiment.
 * It shells out to a standalone Node script rather than importing it so
 * a synthesis error in the pipeline cannot crash the daemon, and so the
 * pipeline stays workspace-tool-agnostic (it runs identically whether
 * invoked by this scheduler, by launchd, or by a human `npx tsx`).
 *
 * Opt-in via runtime config:
 *   ~/.ohwow/config.json { "xIntelEnabled": true, "xIntelIntervalMinutes": 180 }
 * (or the per-workspace workspace.json layer).
 *
 * Preconditions the scheduler does NOT check for you — fast-fail is by
 * the child process:
 *   - Debug Chrome running on the configured CDP port with the right
 *     profile logged into x.com. Without it, the child exits ~20s in.
 *   - ~/.ohwow/workspaces/<ws>/x-config.json defining buckets + sources.
 *     Without it, the child falls back to the public example and warns.
 *
 * Heartbeat: each run writes ~/.ohwow/workspaces/<ws>/x-intel-last-run.json
 * with { ts, workspace, exitCode, durationMs, stdoutTail }. An external
 * watchdog (or the dashboard) can read it to verify the scheduler is
 * still alive and what the last run reported.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { logger } from '../lib/logger.js';

/** Default tick interval — every 3 hours. */
const DEFAULT_INTERVAL_MS = 3 * 60 * 60 * 1000;

/** Cap per-run wall-clock so a hung Chrome never wedges the scheduler. */
const MAX_RUN_WALL_MS = 15 * 60 * 1000;

/** Retain the last 2KB of child stdout in the heartbeat for triage. */
const HEARTBEAT_STDOUT_BYTES = 2048;

export interface XIntelSchedulerOptions {
  /** Workspace slug — drives OHWOW_WORKSPACE so the child picks the right config + knowledge store. */
  workspaceSlug: string;
  /** Per-workspace data dir (…/workspaces/<ws>/). Used for heartbeat. */
  dataDir: string;
  /** Absolute path to the ohwow repo root (where `scripts/` lives). */
  repoRoot: string;
  /** Fire once immediately on start(), don't wait a full interval. Default: false. */
  runOnBoot?: boolean;
  /** Relative path (from repoRoot) to the script to spawn. Default: scripts/x-experiments/x-intel.mjs. */
  scriptRelPath?: string;
  /** Heartbeat filename under dataDir. Default: x-intel-last-run.json. */
  heartbeatName?: string;
  /** Log tag for this scheduler instance. Default: XIntelScheduler. */
  logTag?: string;
}

export class XIntelScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private executing = false;
  private lastExitCode: number | null = null;

  constructor(private readonly opts: XIntelSchedulerOptions) {}

  private get tag(): string {
    return this.opts.logTag ?? '[XIntelScheduler]';
  }
  private get scriptRelPath(): string {
    return this.opts.scriptRelPath ?? 'scripts/x-experiments/x-intel.mjs';
  }
  private get heartbeatName(): string {
    return this.opts.heartbeatName ?? 'x-intel-last-run.json';
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Last child-process exit code (null = never run). For tests + diagnostics. */
  get lastExit(): number | null {
    return this.lastExitCode;
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.running) return;
    this.running = true;
    if (this.opts.runOnBoot) {
      void this.tick();
    }
    this.timer = setInterval(() => void this.tick(), intervalMs);
    logger.info(
      { workspaceSlug: this.opts.workspaceSlug, intervalMs, runOnBoot: !!this.opts.runOnBoot },
      `${this.tag} started`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info(`${this.tag} stopped`);
  }

  /**
   * Single tick of the pipeline. Public so tests can drive it without
   * waiting on the interval. Production callers go through start()/stop().
   */
  async tick(): Promise<void> {
    if (this.executing) {
      logger.debug(`${this.tag} tick already executing — skip`);
      return;
    }
    this.executing = true;
    const started = Date.now();
    try {
      const exitCode = await this.runChild();
      this.lastExitCode = exitCode;
      const durationMs = Date.now() - started;
      logger.info(
        { workspaceSlug: this.opts.workspaceSlug, exitCode, durationMs },
        `${this.tag} tick complete`,
      );
    } catch (err) {
      logger.error({ err }, `${this.tag} tick failed`);
    } finally {
      this.executing = false;
    }
  }

  private runChild(): Promise<number> {
    return new Promise((resolveRun) => {
      const scriptPath = resolvePath(this.opts.repoRoot, this.scriptRelPath);
      const child = spawn('npx', ['tsx', scriptPath], {
        cwd: this.opts.repoRoot,
        env: {
          ...process.env,
          OHWOW_WORKSPACE: this.opts.workspaceSlug,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuf = '';
      let stderrBuf = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        if (stdoutBuf.length > HEARTBEAT_STDOUT_BYTES * 2) {
          stdoutBuf = stdoutBuf.slice(-HEARTBEAT_STDOUT_BYTES * 2);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      const wallTimer = setTimeout(() => {
        logger.warn(
          { workspaceSlug: this.opts.workspaceSlug, maxMs: MAX_RUN_WALL_MS },
          `${this.tag} wall-clock exceeded — killing child`,
        );
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, MAX_RUN_WALL_MS);

      child.on('error', (err) => {
        clearTimeout(wallTimer);
        logger.error({ err }, `${this.tag} child spawn failed`);
        this.writeHeartbeat({ exitCode: -1, durationMs: 0, stdoutTail: stderrBuf.slice(-HEARTBEAT_STDOUT_BYTES) });
        resolveRun(-1);
      });

      const startedAt = Date.now();
      child.on('exit', (code, signal) => {
        clearTimeout(wallTimer);
        const exitCode = code ?? (signal ? -1 : 0);
        const durationMs = Date.now() - startedAt;
        const tail = (stdoutBuf + stderrBuf).slice(-HEARTBEAT_STDOUT_BYTES);
        this.writeHeartbeat({ exitCode, durationMs, stdoutTail: tail });
        resolveRun(exitCode);
      });
    });
  }

  private writeHeartbeat(record: { exitCode: number; durationMs: number; stdoutTail: string }): void {
    try {
      const heartbeatPath = join(this.opts.dataDir, this.heartbeatName);
      mkdirSync(dirname(heartbeatPath), { recursive: true });
      writeFileSync(
        heartbeatPath,
        JSON.stringify(
          {
            ts: new Date().toISOString(),
            workspace: this.opts.workspaceSlug,
            ...record,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      logger.warn({ err }, `${this.tag} failed to write heartbeat`);
    }
  }
}
