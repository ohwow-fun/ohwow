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
  PendingValidation,
  ProbeResult,
  ValidationOutcome,
  ValidationResult,
  Verdict,
} from './experiment-types.js';
import { writeFinding, readRecentFindings } from './findings-store.js';
import {
  enqueueValidation,
  readDueValidations,
  markValidationCompleted,
  markValidationSkipped,
  markValidationError,
} from './validation-store.js';
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

/**
 * Default delay between an intervention landing and its validation
 * firing. Tuned for stale-task-cleanup which wants ~15 min for agents
 * to potentially re-accumulate stale work. Individual experiments can
 * override via cadence.validationDelayMs.
 */
export const DEFAULT_VALIDATION_DELAY_MS = 15 * 60 * 1000;

/**
 * Map ValidationOutcome → Verdict for the validation finding row.
 * 'held' is the happy path (the intervention is still effective),
 * 'failed' is the action-needed path (the intervention rebounded),
 * 'inconclusive' is a soft warning.
 */
function verdictForOutcome(outcome: ValidationOutcome): Verdict {
  if (outcome === 'held') return 'pass';
  if (outcome === 'inconclusive') return 'warning';
  return 'fail';
}

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
   * Single tick: walk registered experiments, run any that are due,
   * then drain the validation queue of any due accountability checks.
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

      // Validation queue: process every pending validation whose
      // validate_at has passed. Runs AFTER the experiment loop so a
      // brand-new intervention from this tick doesn't immediately
      // cascade into its own validation on the same tick.
      await this.processValidationQueue();
    } finally {
      this.running = false;
    }
  }

  /**
   * Drain any pending validations whose validate_at has passed. Each
   * validation reads the experiment from the registry, calls its
   * validate() hook with the stored baseline, writes a self_findings
   * row in category='validation', and updates the validation row.
   *
   * Safe to call outside tick() — used by tests.
   */
  async processValidationQueue(): Promise<void> {
    const due = await readDueValidations(this.db, new Date(this.now()).toISOString()).catch(
      (err) => {
        logger.warn({ err }, '[runner] failed to read due validations');
        return [] as PendingValidation[];
      },
    );

    for (const pending of due) {
      await this.runOneValidation(pending);
    }
  }

  private async runOneValidation(pending: PendingValidation): Promise<void> {
    const exp = this.experiments.get(pending.experimentId);

    if (!exp) {
      await markValidationSkipped(
        this.db,
        pending.id,
        `experiment ${pending.experimentId} is not registered at validation time`,
      ).catch((err) => logger.warn({ err }, '[runner] failed to mark validation skipped'));
      return;
    }

    if (!exp.validate) {
      await markValidationSkipped(
        this.db,
        pending.id,
        `experiment ${pending.experimentId} no longer implements validate()`,
      ).catch((err) => logger.warn({ err }, '[runner] failed to mark validation skipped'));
      return;
    }

    const started = this.now();
    const ctx = this.buildContext();
    let result: ValidationResult | null = null;
    let errorMessage: string | null = null;

    try {
      result = await exp.validate(pending.baseline, ctx);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err, experimentId: exp.id, validationId: pending.id },
        '[runner] validate() threw',
      );
    }

    if (!result) {
      await markValidationError(this.db, pending.id, errorMessage ?? 'unknown validation failure')
        .catch((err) => logger.warn({ err }, '[runner] failed to mark validation error'));
      // Also write a finding so the error is visible in the ledger.
      try {
        await writeFinding(this.db, {
          experimentId: exp.id,
          category: 'validation',
          subject: `intervention:${pending.interventionFindingId}`,
          hypothesis: `Validation of intervention finding ${pending.interventionFindingId}`,
          verdict: 'error',
          summary: `validate() threw: ${errorMessage ?? 'unknown error'}`,
          evidence: {
            is_validation: true,
            intervention_finding_id: pending.interventionFindingId,
            validation_id: pending.id,
            baseline: pending.baseline,
            error: errorMessage,
          },
          interventionApplied: null,
          ranAt: new Date(started).toISOString(),
          durationMs: this.now() - started,
        });
      } catch { /* best effort */ }
      return;
    }

    try {
      const findingId = await writeFinding(this.db, {
        experimentId: exp.id,
        category: 'validation',
        subject: `intervention:${pending.interventionFindingId}`,
        hypothesis: `Validation of intervention finding ${pending.interventionFindingId}`,
        verdict: verdictForOutcome(result.outcome),
        summary: result.summary,
        evidence: {
          is_validation: true,
          intervention_finding_id: pending.interventionFindingId,
          validation_id: pending.id,
          baseline: pending.baseline,
          outcome: result.outcome,
          ...result.evidence,
        },
        interventionApplied: null,
        ranAt: new Date(started).toISOString(),
        durationMs: this.now() - started,
      });

      await markValidationCompleted(this.db, pending.id, result.outcome, findingId).catch(
        (err) => logger.warn({ err }, '[runner] failed to mark validation completed'),
      );

      logger.debug(
        {
          experimentId: exp.id,
          validationId: pending.id,
          outcome: result.outcome,
          durationMs: this.now() - started,
        },
        '[runner] validation completed',
      );
    } catch (err) {
      logger.warn(
        { err, experimentId: exp.id, validationId: pending.id },
        '[runner] failed to persist validation finding',
      );
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

    let findingId: string | null = null;
    try {
      findingId = await writeFinding(this.db, {
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

    // Phase 3: if this run applied an intervention AND the experiment
    // implements validate(), enqueue a validation row so the runner
    // loops back and verifies the intervention held. Without this,
    // interventions are fire-and-forget — no audit trail, no rollback
    // signal, no feedback loop.
    if (findingId && intervention && exp.validate) {
      const delay = exp.cadence.validationDelayMs ?? DEFAULT_VALIDATION_DELAY_MS;
      const validateAt = new Date(this.now() + delay).toISOString();
      try {
        await enqueueValidation(this.db, {
          interventionFindingId: findingId,
          experimentId: exp.id,
          baseline: intervention.details,
          validateAt,
        });
        logger.debug(
          { experimentId: exp.id, findingId, validateAt },
          '[runner] queued validation for intervention',
        );
      } catch (err) {
        logger.warn(
          { err, experimentId: exp.id, findingId },
          '[runner] failed to enqueue validation',
        );
      }
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
