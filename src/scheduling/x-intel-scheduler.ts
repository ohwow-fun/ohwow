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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  /** Extra env vars for the primary script's child process. Merged onto process.env. */
  env?: Record<string, string>;
  /**
   * Chain one or more child scripts after the primary exits 0. Each
   * step runs sequentially after the previous one; non-zero exit in
   * any step is logged but doesn't halt later steps. Used to run
   * x-authors-to-crm, x-compose, and x-reply all triggered off the
   * same x-intel heartbeat (they all need its fresh sidecars).
   *
   * Accepts a single step object for backward compatibility; a single
   * object is treated as a one-element array.
   */
  chainOnZeroExit?: ChainStep | ChainStep[];
}

export interface ChainStep {
  enabled: boolean;
  scriptRelPath: string;
  heartbeatName: string;
  logTag?: string;
  /** Extra env vars passed to the child (merged onto process.env). */
  env?: Record<string, string>;
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

    // Persistence: resume the cadence from the last heartbeat instead of
    // resetting the timer on every boot. With the ohwow daemon restarted
    // dozens of times per dev day, a naive setInterval with
    // runOnBoot:false never reaches its full period and the pipeline
    // silently drifts. The heartbeat file's `ts` is our authoritative
    // "last attempted run" — if the gap since then is already past the
    // interval, fire immediately; otherwise schedule the first fire for
    // the remainder.
    const lastTs = this.readHeartbeatTs();
    const now = Date.now();
    let firstFireDelayMs: number;
    if (lastTs !== null) {
      firstFireDelayMs = Math.max(0, intervalMs - (now - lastTs));
    } else if (this.opts.runOnBoot) {
      firstFireDelayMs = 0;
    } else {
      firstFireDelayMs = intervalMs;
    }

    const armInterval = () => {
      this.timer = setInterval(() => void this.tick(), intervalMs);
    };

    if (firstFireDelayMs === 0) {
      void this.tick();
      armInterval();
    } else {
      // setTimeout + setInterval share the NodeJS.Timeout type, and
      // clearInterval is an alias for clearTimeout, so storing the
      // handle in `this.timer` and stopping via the existing stop()
      // path works for both phases.
      this.timer = setTimeout(() => {
        void this.tick();
        armInterval();
      }, firstFireDelayMs);
    }

    logger.info(
      {
        workspaceSlug: this.opts.workspaceSlug,
        intervalMs,
        runOnBoot: !!this.opts.runOnBoot,
        firstFireDelayMs,
        lastRunAt: lastTs ? new Date(lastTs).toISOString() : null,
      },
      `${this.tag} started`,
    );
  }

  /**
   * Read the last run timestamp from our heartbeat file. Returns null
   * for any "no prior run observable" case (file missing, corrupt, or
   * missing `ts` field) so callers fall through to the runOnBoot /
   * fresh-install branch.
   */
  private readHeartbeatTs(): number | null {
    try {
      const heartbeatPath = join(this.opts.dataDir, this.heartbeatName);
      const raw = readFileSync(heartbeatPath, 'utf8');
      const parsed = JSON.parse(raw) as { ts?: string };
      if (!parsed || typeof parsed.ts !== 'string') return null;
      const ms = Date.parse(parsed.ts);
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
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
      const exitCode = await this.runScript(this.scriptRelPath, this.heartbeatName, this.tag, this.opts.env);
      this.lastExitCode = exitCode;
      const durationMs = Date.now() - started;
      logger.info(
        { workspaceSlug: this.opts.workspaceSlug, exitCode, durationMs },
        `${this.tag} tick complete`,
      );
      if (exitCode === 0 && this.opts.chainOnZeroExit) {
        const rawChain = this.opts.chainOnZeroExit;
        const chainSteps: ChainStep[] = Array.isArray(rawChain) ? rawChain : [rawChain];
        for (const step of chainSteps) {
          if (!step.enabled) continue;
          const stepTag = step.logTag ?? '[XIntelScheduler:chain]';
          const stepStarted = Date.now();
          const stepExit = await this.runScript(step.scriptRelPath, step.heartbeatName, stepTag, step.env);
          logger.info(
            {
              workspaceSlug: this.opts.workspaceSlug,
              exitCode: stepExit,
              durationMs: Date.now() - stepStarted,
            },
            `${stepTag} chain step complete`,
          );
        }
      }
    } catch (err) {
      logger.error({ err }, `${this.tag} tick failed`);
    } finally {
      this.executing = false;
    }
  }

  private runScript(scriptRelPath: string, heartbeatName: string, tag: string, extraEnv?: Record<string, string>): Promise<number> {
    return new Promise((resolveRun) => {
      const scriptPath = resolvePath(this.opts.repoRoot, scriptRelPath);
      // Browser work here runs in a spawned Node process, so the
      // in-process withCdpLane (src/execution/browser/cdp-lane.ts) used
      // by XDmPollerScheduler and ContentCadenceScheduler does NOT
      // serialize against this path. CDP use from these scripts is
      // currently advisory and treated as outside the workspace lane.
      const child = spawn('npx', ['tsx', scriptPath], {
        cwd: this.opts.repoRoot,
        env: {
          ...process.env,
          OHWOW_WORKSPACE: this.opts.workspaceSlug,
          OHWOW_PORT: process.env.OHWOW_PORT ?? '',
          ...(extraEnv ?? {}),
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
          `${tag} wall-clock exceeded — killing child`,
        );
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, MAX_RUN_WALL_MS);

      child.on('error', (err) => {
        clearTimeout(wallTimer);
        logger.error({ err }, `${tag} child spawn failed`);
        this.writeHeartbeat(heartbeatName, { exitCode: -1, durationMs: 0, stdoutTail: stderrBuf.slice(-HEARTBEAT_STDOUT_BYTES) });
        resolveRun(-1);
      });

      const startedAt = Date.now();
      child.on('exit', (code, signal) => {
        clearTimeout(wallTimer);
        const exitCode = code ?? (signal ? -1 : 0);
        const durationMs = Date.now() - startedAt;
        const tail = (stdoutBuf + stderrBuf).slice(-HEARTBEAT_STDOUT_BYTES);
        this.writeHeartbeat(heartbeatName, { exitCode, durationMs, stdoutTail: tail });
        resolveRun(exitCode);
      });
    });
  }

  private writeHeartbeat(heartbeatName: string, record: { exitCode: number; durationMs: number; stdoutTail: string }): void {
    try {
      const heartbeatPath = join(this.opts.dataDir, heartbeatName);
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
