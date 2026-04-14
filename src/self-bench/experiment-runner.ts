/**
 * ExperimentRunner — schedules and executes registered Experiments.
 *
 * The daemon instantiates one runner on boot, registers every
 * Experiment it knows about, and calls start() to kick the tick
 * interval. On each tick the runner walks the registered set and
 * executes any experiment whose next-run time has passed. Each
 * execution follows the lifecycle:
 *
 *   probe(ctx)
 *     → judge(result, history)
 *       → intervene?(verdict, result, ctx)   [optional]
 *         → writeFinding(db, row)
 *
 * Every run lands a row in self_findings, even passing runs. That's
 * load-bearing: passing rows are how the system knows something was
 * checked recently. A missing finding means "we haven't probed this
 * in a while" and the meta-loop (Phase 4) will use that gap signal
 * to bias probe selection.
 *
 * Error recovery: probe() and judge() errors produce a finding with
 * verdict='error' and the error message in summary, then the runner
 * moves on. The runner never throws out of tick() — a broken
 * experiment must not take down the daemon.
 *
 * Concurrency: tick() uses a simple `this.running` flag so overlapping
 * ticks don't run the same experiment twice. If a tick is still in
 * flight when the next interval fires, the new one is skipped. Phase
 * 1 experiments are all cheap DB reads so this is fine; long-running
 * experiments in later phases will need their own concurrency control.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';
import type {
  Experiment,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from './experiment-types.js';
import { writeFinding, readRecentFindings } from './findings-store.js';
import { logger } from '../lib/logger.js';

/**
 * How often the runner wakes up to check for due experiments. Set at
 * the daemon wire point — the default here is conservative (60s) so
 * tests can override it.
 */
export const DEFAULT_TICK_INTERVAL_MS = 60_000;

/**
 * How many past findings the runner fetches and passes to judge(). A
 * judge that needs more can call ctx.recentFindings() itself.
 */
const JUDGE_HISTORY_LIMIT = 20;

export interface ExperimentRunnerOptions {
  /** Override the tick interval (useful for tests). */
  tickIntervalMs?: number;
  /**
   * Clock override for tests. Production passes Date.now.
   */
  now?: () => number;
}

export class ExperimentRunner {
  private experiments = new Map<string, Experiment>();
  private nextRunAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly tickIntervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly engine: RuntimeEngine,
    private readonly workspaceId: string,
    opts: ExperimentRunnerOptions = {},
  ) {
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Register an experiment. Duplicate ids overwrite silently — last
   * registration wins. That lets a daemon hot-reload a single
   * experiment without restarting the whole runner.
   */
  register(experiment: Experiment): void {
    this.experiments.set(experiment.id, experiment);
    const first = experiment.cadence.runOnBoot
      ? this.now()
      : this.now() + Math.max(0, experiment.cadence.everyMs);
    this.nextRunAt.set(experiment.id, first);
    logger.debug(
      { experimentId: experiment.id, category: experiment.category, firstRunAt: new Date(first).toISOString() },
      '[runner] registered experiment',
    );
  }

  /** Remove an experiment from the schedule. Idempotent. */
  unregister(experimentId: string): void {
    this.experiments.delete(experimentId);
    this.nextRunAt.delete(experimentId);
  }

  /** List registered experiment ids — used by operator surfaces. */
  registeredIds(): string[] {
    return Array.from(this.experiments.keys());
  }

  /**
   * Start the tick interval. The first tick fires immediately so
   * experiments with runOnBoot: true execute without a full tick
   * delay. Subsequent ticks run every tickIntervalMs.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.tickIntervalMs);
    void this.tick();
    logger.info({ tickIntervalMs: this.tickIntervalMs }, '[runner] started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[runner] stopped');
    }
  }

  /**
   * Single tick: walk registered experiments, run any that are due.
   * Exposed for tests — production code should only call start/stop.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      for (const [id, exp] of this.experiments) {
        const due = this.nextRunAt.get(id) ?? 0;
        if (due > now) continue;
        await this.runOne(exp);
        // Schedule next run. Use now-after-completion so a slow probe
        // doesn't pile up missed runs.
        this.nextRunAt.set(id, this.now() + Math.max(0, exp.cadence.everyMs));
      }
    } finally {
      this.running = false;
    }
  }

  private buildContext(): ExperimentContext {
    return {
      db: this.db,
      workspaceId: this.workspaceId,
      engine: this.engine,
      recentFindings: (experimentId: string, limit?: number) =>
        readRecentFindings(this.db, experimentId, limit),
    };
  }

  private async runOne(exp: Experiment): Promise<void> {
    const started = this.now();
    const ctx = this.buildContext();
    let probeResult: ProbeResult | null = null;
    let verdict: Verdict = 'error';
    let intervention: InterventionApplied | null = null;
    let errorSummary: string | null = null;

    try {
      probeResult = await exp.probe(ctx);
      const history = await readRecentFindings(this.db, exp.id, JUDGE_HISTORY_LIMIT);
      verdict = exp.judge(probeResult, history);
      if (exp.intervene && verdict !== 'pass' && verdict !== 'error') {
        intervention = (await exp.intervene(verdict, probeResult, ctx)) ?? null;
      }
    } catch (err) {
      errorSummary = err instanceof Error ? err.message : String(err);
      verdict = 'error';
      logger.warn({ err, experimentId: exp.id }, '[runner] experiment threw');
    }

    try {
      await writeFinding(this.db, {
        experimentId: exp.id,
        category: exp.category,
        subject: probeResult?.subject ?? null,
        hypothesis: exp.hypothesis,
        verdict,
        summary: probeResult?.summary ?? errorSummary ?? 'experiment produced no result',
        evidence: probeResult?.evidence ?? (errorSummary ? { error: errorSummary } : {}),
        interventionApplied: intervention,
        ranAt: new Date(started).toISOString(),
        durationMs: this.now() - started,
      });
    } catch (err) {
      // Swallow store failures — we already logged the experiment
      // result and writing the finding is best-effort.
      logger.warn({ err, experimentId: exp.id }, '[runner] failed to persist finding');
    }

    logger.debug(
      {
        experimentId: exp.id,
        verdict,
        durationMs: this.now() - started,
        intervention: intervention?.description,
      },
      '[runner] experiment completed',
    );
  }
}

// Re-exports for convenience at the runner call site.
export type { Experiment, ExperimentContext, Finding, ProbeResult, Verdict };
