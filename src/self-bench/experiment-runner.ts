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
 * Concurrency: experiments run in parallel within a tick AND across
 * overlapping ticks, guarded by per-experiment inFlight tracking.
 * A slow experiment (e.g. the Phase 7-D author running
 * `npm run typecheck` + vitest for 30-90s) never blocks fast
 * experiments from running — it just prevents its own cadence from
 * double-firing. setInterval re-enters tick() independently of any
 * outstanding await, so a 90s author tick lets fast experiments keep
 * ticking through at their own cadence during that window.
 *
 * The validation queue drain has its own reentrancy guard
 * (processingValidations) because two overlapping ticks both calling
 * processValidationQueue() would race on marking pending validations
 * completed.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';
import type {
  Experiment,
  ExperimentCadence,
  ExperimentCategory,
  ExperimentContext,
  ExperimentScheduler,
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
  markValidationRolledBack,
} from './validation-store.js';
import { logger } from '../lib/logger.js';

/**
 * How often the runner wakes up to check for due experiments. Set at
 * the daemon wire point — the default here is conservative (60s) so
 * tests can override it.
 */
export const DEFAULT_TICK_INTERVAL_MS = 5_000;

/**
 * When a run yields a warning/fail verdict, pull the next run in to
 * this short delay instead of waiting the full cadence.everyMs. Gives
 * the loop real-time reactivity on signal while passing probes stay
 * on their normal schedule.
 */
export const REACTIVE_RESCHEDULE_MS = 5_000;

/**
 * Cap on back-to-back synchronous tick() sweeps per outer tick. After
 * the cap we yield to setInterval. This is the circuit breaker if an
 * experiment has everyMs=0 or clocks misbehave.
 */
export const MAX_CHAIN_DEPTH = 8;

/**
 * How many past findings the runner fetches and passes to judge(). A
 * judge that needs more can call ctx.recentFindings() itself.
 */
const JUDGE_HISTORY_LIMIT = 20;

/**
 * Default delay between an intervention landing and its validation
 * firing. Set to 5 min to match the accelerated 5-min probe cadences.
 * Individual experiments can override via cadence.validationDelayMs
 * (e.g. stale-task-cleanup uses a longer window so agents have time
 * to re-accumulate stale work before the validation check fires).
 */
export const DEFAULT_VALIDATION_DELAY_MS = 5 * 60 * 1000;

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

const VERDICT_SEVERITY: Record<Verdict, number> = {
  pass: 0,
  warning: 1,
  fail: 2,
  error: 3,
};

/**
 * Keys we treat as "burn-down" scalars: a decrease after the
 * intervention means real progress even if the coarse verdict stayed
 * the same. Pool-draining experiments (experiment-author walking a
 * registry backlog, source-copy-lint fixing violations N-at-a-time)
 * produce this shape — one tick moves a counter by 1/N but verdict
 * stays warning until the whole pool drains. Without this, every
 * honest incremental fix reads as "failed" in the validator.
 */
const BURN_DOWN_KEY_SUFFIXES = [
  '_count',
  '_pool',
  '_backlog',
  '_unclaimed',
  '_failures',
  '_violations',
  '_pending',
];

function isBurnDownKey(key: string): boolean {
  return BURN_DOWN_KEY_SUFFIXES.some((suf) => key.endsWith(suf));
}

function collectBurnDownScalars(
  ev: Record<string, unknown>,
  allowedKeys?: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>();
  // Opt-in list: empty array means "no burn-down keys for this
  // experiment" (forces inconclusive when verdict is flat). A non-empty
  // list means "only these exact keys count as burn-down." When
  // undefined, fall back to suffix-based heuristic for back-compat.
  const matches = allowedKeys
    ? (k: string): boolean => allowedKeys.includes(k)
    : isBurnDownKey;
  for (const [k, v] of Object.entries(ev)) {
    if (typeof v === 'number' && Number.isFinite(v) && matches(k)) {
      out.set(k, v);
    }
  }
  return out;
}

/**
 * Fallback validator used when an experiment produced an intervention
 * but didn't implement validate() itself. Re-runs probe()+judge() and
 * compares the fresh verdict against the verdict at intervene time
 * (stashed under `__autoFollowupPreVerdict` in the baseline), then
 * falls back to scalar-improvement detection on burn-down keys so
 * pool-draining interventions aren't misread as regressions.
 *
 * Contract:
 *   - probe errored                    → inconclusive
 *   - new verdict === 'pass'           → held (intervention moved us to healthy)
 *   - new severity < pre severity      → held (state improved)
 *   - any burn-down scalar decreased   → held (incremental progress)
 *   - new severity > pre severity      → failed (regressed after intervention)
 *   - severity flat, no scalars on either side → inconclusive (unmeasurable —
 *     the probe exposes no burn-down signal, so "failed" would be a false
 *     positive for every probe in this shape)
 *   - severity flat, scalars present but didn't improve → failed
 *     (intervention didn't move the needle)
 */
async function autoFollowupValidate(
  exp: Experiment,
  baseline: Record<string, unknown>,
  ctx: ExperimentContext,
): Promise<ValidationResult> {
  const rawPre = baseline['__autoFollowupPreVerdict'];
  const preVerdict: Verdict =
    rawPre === 'pass' || rawPre === 'warning' || rawPre === 'fail' || rawPre === 'error'
      ? rawPre
      : 'warning';
  const preEvidenceRaw = baseline['__autoFollowupPreEvidence'];
  const preEvidence =
    preEvidenceRaw && typeof preEvidenceRaw === 'object'
      ? (preEvidenceRaw as Record<string, unknown>)
      : {};

  let probeResult: ProbeResult;
  try {
    probeResult = await exp.probe(ctx);
  } catch (err) {
    return {
      outcome: 'inconclusive',
      summary: `auto-followup probe threw: ${err instanceof Error ? err.message : String(err)}`,
      evidence: { auto_followup: true, pre_verdict: preVerdict, probe_error: true },
    };
  }

  const newVerdict = exp.judge(probeResult, []);
  const preSeverity = VERDICT_SEVERITY[preVerdict];
  const newSeverity = VERDICT_SEVERITY[newVerdict];

  const preScalars = collectBurnDownScalars(preEvidence, exp.burnDownKeys);
  const postScalars = collectBurnDownScalars(
    probeResult.evidence as Record<string, unknown>,
    exp.burnDownKeys,
  );
  const improvements: Array<{ key: string; from: number; to: number }> = [];
  for (const [k, before] of preScalars) {
    const after = postScalars.get(k);
    if (after !== undefined && after < before) {
      improvements.push({ key: k, from: before, to: after });
    }
  }

  let outcome: ValidationOutcome;
  let reason: string;
  if (newVerdict === 'pass' || newSeverity < preSeverity) {
    outcome = 'held';
    reason = 'verdict improved';
  } else if (improvements.length > 0) {
    outcome = 'held';
    reason = `${improvements.length} burn-down scalar(s) decreased`;
  } else if (newSeverity > preSeverity) {
    outcome = 'failed';
    reason = 'verdict regressed after intervention';
  } else if (preScalars.size === 0 && postScalars.size === 0) {
    // No burn-down scalars on either side AND verdict is flat. We have
    // no measurable signal to judge the intervention — marking this
    // `failed` would be a false positive (every auto-followup for a
    // probe in this shape is mathematically guaranteed to fail).
    outcome = 'inconclusive';
    reason = 'no burn-down signal to measure — verdict flat, no scalars';
  } else {
    outcome = 'failed';
    reason = 'verdict flat and burn-down scalars did not improve';
  }

  return {
    outcome,
    summary: `auto-followup: pre=${preVerdict} post=${newVerdict} → ${outcome} (${reason})`,
    evidence: {
      auto_followup: true,
      pre_verdict: preVerdict,
      post_verdict: newVerdict,
      post_summary: probeResult.summary,
      post_evidence: probeResult.evidence,
      improvements,
      outcome_reason: reason,
    },
  };
}

export interface ExperimentRunnerOptions {
  /** Override the tick interval (useful for tests). */
  tickIntervalMs?: number;
  /**
   * Clock override for tests. Production passes Date.now.
   */
  now?: () => number;
}

export class ExperimentRunner implements ExperimentScheduler {
  private experiments = new Map<string, Experiment>();
  private nextRunAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Per-experiment in-flight claims. Added synchronously inside
   * tick() BEFORE any await so two overlapping ticks can't both
   * pick up the same experiment. Cleared in runOne()'s finally
   * block so even a throwing experiment releases its claim.
   */
  private inFlight = new Set<string>();
  /**
   * Reentrancy guard for processValidationQueue specifically. Two
   * parallel ticks both draining the queue would race on marking
   * pending validations completed.
   */
  private processingValidations = false;
  /** Recursion depth for synchronous tick chaining (T3). */
  private chainDepth = 0;
  private readonly tickIntervalMs: number;
  private readonly now: () => number;
  /**
   * Wall-clock ms recorded at start(). Exposed via ExperimentContext
   * so history-aggregating probes can treat restart as a state
   * boundary and floor their lookback windows here.
   */
  private startedAtMs = 0;

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly engine: RuntimeEngine,
    private readonly workspaceId: string,
    private readonly workspaceSlug: string,
    opts: ExperimentRunnerOptions = {},
  ) {
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * ExperimentScheduler implementation — lets meta-experiments
   * (AdaptiveSchedulerExperiment) override peer cadences at runtime.
   * No-op on unknown ids; past timestamps clamp to "immediate" so
   * the next tick picks them up.
   */
  setNextRunAt(experimentId: string, timestampMs: number): void {
    if (!this.experiments.has(experimentId)) return;
    const clamped = Math.max(timestampMs, this.now());
    this.nextRunAt.set(experimentId, clamped);
  }

  /**
   * Snapshot the full registry for meta-experiments. Returns a
   * plain array so callers can filter / sort freely without
   * touching the runner's private state.
   */
  getRegisteredExperimentInfo(): Array<{
    id: string;
    name: string;
    category: ExperimentCategory;
    cadence: ExperimentCadence;
    nextRunAt: number;
  }> {
    const out: Array<{
      id: string;
      name: string;
      category: ExperimentCategory;
      cadence: ExperimentCadence;
      nextRunAt: number;
    }> = [];
    for (const [id, exp] of this.experiments) {
      out.push({
        id,
        name: exp.name,
        category: exp.category,
        cadence: exp.cadence,
        nextRunAt: this.nextRunAt.get(id) ?? 0,
      });
    }
    return out;
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
   * Restore nextRunAt from self_findings so experiments survive daemon
   * restarts. Without this, register() always schedules the next run at
   * now + everyMs, and any experiment whose cadence is longer than the
   * average daemon restart interval never fires — we caught this with
   * LoopCadenceProbe flagging 20 hourly migration-schema probes stuck
   * after dev-loop restarts.
   *
   * Call once after all register() calls and before start(). For each
   * experiment with runOnBoot:false and a prior finding, set
   * nextRunAt = max(now, lastRanAt + everyMs). Overdue clamps to now
   * so the next tick picks them up; fresh runs wait out the remainder.
   */
  async rehydrateSchedule(): Promise<void> {
    const now = this.now();
    for (const [id, exp] of this.experiments) {
      if (exp.cadence.runOnBoot) continue;
      const recent = await readRecentFindings(this.db, id, 1).catch(() => [] as Finding[]);
      if (recent.length === 0) continue;
      const lastRanMs = Date.parse(recent[0].ranAt);
      if (!Number.isFinite(lastRanMs)) continue;
      const next = Math.max(now, lastRanMs + Math.max(0, exp.cadence.everyMs));
      this.nextRunAt.set(id, next);
    }
  }

  /**
   * Start the tick interval. The first tick fires immediately so
   * experiments with runOnBoot: true execute without a full tick
   * delay. Subsequent ticks run every tickIntervalMs.
   */
  start(): void {
    if (this.timer) return;
    this.startedAtMs = this.now();
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
    const now = this.now();

    // Collection pass is fully synchronous — claim inFlight BEFORE
    // any await so a second tick re-entering this method during the
    // Promise.all below cannot also claim the same experiment.
    const due: Experiment[] = [];
    for (const [id, exp] of this.experiments) {
      const nextAt = this.nextRunAt.get(id) ?? 0;
      if (nextAt > now) continue;
      if (this.inFlight.has(id)) continue;
      this.inFlight.add(id);
      due.push(exp);
    }

    // Fire all due experiments in parallel. Each runOne() handles its
    // own inFlight cleanup + nextRunAt reschedule in a finally block
    // so a throwing experiment still releases its claim.
    await Promise.all(due.map((exp) => this.runOne(exp)));

    // T3: if this sweep ran anything, chain one more sweep so the
    // next eligible experiment fires immediately instead of waiting
    // for the heartbeat. MAX_CHAIN_DEPTH is the circuit breaker.
    if (due.length > 0 && this.chainDepth < MAX_CHAIN_DEPTH) {
      this.chainDepth++;
      try {
        await this.tick();
      } finally {
        this.chainDepth--;
      }
    }

    // Validation queue: process every pending validation whose
    // validate_at has passed. Only drain at the outer tick so
    // recursive chains don't re-enter the drain loop for no reason.
    if (this.chainDepth > 0) return;
    if (this.processingValidations) return;
    this.processingValidations = true;
    try {
      await this.processValidationQueue();
    } finally {
      this.processingValidations = false;
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

    const started = this.now();
    const ctx = this.buildContext();
    let result: ValidationResult | null = null;
    let errorMessage: string | null = null;

    // Strip the reserved auto-followup metadata so user-defined
    // validate()/rollback() and the evidence ledger see exactly the
    // intervention.details the experiment produced. The raw baseline
    // (with __autoFollowupPreVerdict) is passed only to
    // autoFollowupValidate, which needs the stashed preVerdict.
    const cleanBaseline: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(pending.baseline)) {
      if (k === '__autoFollowupPreVerdict') continue;
      if (k === '__autoFollowupPreEvidence') continue;
      cleanBaseline[k] = v;
    }

    try {
      if (exp.validate) {
        result = await exp.validate(cleanBaseline, ctx);
      } else {
        // Auto-followup: experiment didn't implement validate(), so
        // re-run its probe and compare the new verdict against the
        // pre-intervention verdict we stashed at enqueue time. This
        // wires every intervening experiment into the accountability
        // loop without requiring each to author its own validator.
        result = await autoFollowupValidate(exp, pending.baseline, ctx);
      }
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
            baseline: cleanBaseline,
            error: errorMessage,
          },
          interventionApplied: null,
          ranAt: new Date(started).toISOString(),
          durationMs: this.now() - started,
        });
      } catch { /* best effort */ }
      return;
    }

    let validationFindingId: string | null = null;
    try {
      validationFindingId = await writeFinding(this.db, {
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
          baseline: cleanBaseline,
          outcome: result.outcome,
          ...result.evidence,
        },
        interventionApplied: null,
        ranAt: new Date(started).toISOString(),
        durationMs: this.now() - started,
      });

      await markValidationCompleted(this.db, pending.id, result.outcome, validationFindingId).catch(
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

    // Phase 5 — automatic rollback when validation failed AND the
    // experiment implements the hook. The rollback is the runner
    // self-healing: we applied a change, measured it, the measurement
    // said the change didn't hold, so we undo it without operator
    // intervention. Lands as its own finding in category='validation'
    // with verdict='warning' (a rollback is noteworthy but not an
    // error), and stamps the validation row via
    // markValidationRolledBack so queries can filter
    // "failed AND not rolled back" vs "failed AND self-healed."
    if (result.outcome === 'failed' && exp.rollback) {
      const rollbackStarted = this.now();
      let rollbackApplied: InterventionApplied | null = null;
      let rollbackError: string | null = null;
      try {
        rollbackApplied = (await exp.rollback(cleanBaseline, ctx)) ?? null;
      } catch (err) {
        rollbackError = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err, experimentId: exp.id, validationId: pending.id },
          '[runner] rollback() threw',
        );
      }

      if (rollbackApplied) {
        try {
          const rollbackFindingId = await writeFinding(this.db, {
            experimentId: exp.id,
            category: 'validation',
            subject: `rollback:${pending.interventionFindingId}`,
            hypothesis: `Auto-rollback of intervention finding ${pending.interventionFindingId} after validation outcome=failed`,
            verdict: 'warning',
            summary: `rollback: ${rollbackApplied.description}`,
            evidence: {
              is_rollback: true,
              intervention_finding_id: pending.interventionFindingId,
              validation_id: pending.id,
              validation_finding_id: validationFindingId,
              baseline: cleanBaseline,
              rollback_details: rollbackApplied.details,
            },
            interventionApplied: rollbackApplied,
            ranAt: new Date(rollbackStarted).toISOString(),
            durationMs: this.now() - rollbackStarted,
          });
          await markValidationRolledBack(this.db, pending.id, rollbackFindingId).catch(
            (err) => logger.warn({ err }, '[runner] failed to stamp rollback on validation'),
          );
          logger.info(
            {
              experimentId: exp.id,
              validationId: pending.id,
              rollbackFindingId,
              durationMs: this.now() - rollbackStarted,
            },
            '[runner] rollback applied',
          );
        } catch (err) {
          logger.warn(
            { err, experimentId: exp.id, validationId: pending.id },
            '[runner] failed to persist rollback finding',
          );
        }
      } else if (rollbackError) {
        // rollback() threw. Write an error finding so operators see it.
        try {
          await writeFinding(this.db, {
            experimentId: exp.id,
            category: 'validation',
            subject: `rollback:${pending.interventionFindingId}`,
            hypothesis: `Auto-rollback attempt for ${pending.interventionFindingId}`,
            verdict: 'error',
            summary: `rollback() threw: ${rollbackError}`,
            evidence: {
              is_rollback: true,
              intervention_finding_id: pending.interventionFindingId,
              validation_id: pending.id,
              error: rollbackError,
              baseline: cleanBaseline,
            },
            interventionApplied: null,
            ranAt: new Date(rollbackStarted).toISOString(),
            durationMs: this.now() - rollbackStarted,
          });
        } catch { /* best effort */ }
      }
    }
  }

  private buildContext(): ExperimentContext {
    return {
      db: this.db,
      workspaceId: this.workspaceId,
      workspaceSlug: this.workspaceSlug,
      engine: this.engine,
      recentFindings: (experimentId: string, limit?: number) =>
        readRecentFindings(this.db, experimentId, limit),
      scheduler: this,
      runnerStartedAtMs: this.startedAtMs || undefined,
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
      try {
        probeResult = await exp.probe(ctx);
        const history = await readRecentFindings(this.db, exp.id, JUDGE_HISTORY_LIMIT);
        verdict = exp.judge(probeResult, history);
        // Invoke intervene on any non-error verdict. Historically
        // this was gated on verdict !== 'pass' as well, but that
        // blocked meta-experiments like AdaptiveSchedulerExperiment
        // whose routine successful work IS the intervention. Existing
        // experiments that don't want to mutate on pass already
        // early-return null (ModelHealthExperiment, StaleTaskCleanup)
        // so this is backward-compatible — the gate only ever blocked
        // intent, not a real safety rule.
        if (exp.intervene && verdict !== 'error') {
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

      // Phase 3: if this run applied an intervention, enqueue a
      // validation row so the runner loops back and verifies the
      // intervention held. Without this, interventions are fire-and-
      // forget — no audit trail, no rollback signal, no feedback loop.
      //
      // Experiments that implement validate() get their own accountability
      // hook. Experiments that don't fall through to the auto-followup
      // path in runOneValidation: probe again, compare verdicts against
      // the stored preVerdict, call it held/failed/inconclusive.
      if (findingId && intervention) {
        const delay = exp.cadence.validationDelayMs ?? DEFAULT_VALIDATION_DELAY_MS;
        const validateAt = new Date(this.now() + delay).toISOString();
        try {
          await enqueueValidation(this.db, {
            interventionFindingId: findingId,
            experimentId: exp.id,
            baseline: {
              ...intervention.details,
              __autoFollowupPreVerdict: verdict,
              ...(probeResult
                ? { __autoFollowupPreEvidence: probeResult.evidence }
                : {}),
            },
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
    } finally {
      // Always release the inFlight claim and reschedule the next
      // run, even if something above threw. Using now-after-completion
      // so a slow probe doesn't pile up missed runs back-to-back.
      this.inFlight.delete(exp.id);
      // T2: on warning/fail, pull the next run in so the loop reacts
      // to signal in near-real-time. Passing probes keep their normal
      // cadence.
      const reactive = verdict === 'warning' || verdict === 'fail';
      const delay = reactive
        ? REACTIVE_RESCHEDULE_MS
        : Math.max(0, exp.cadence.everyMs);
      this.nextRunAt.set(exp.id, this.now() + delay);
    }
  }
}

// Re-exports for convenience at the runner call site.
export type { Experiment, ExperimentContext, Finding, ProbeResult, Verdict };
