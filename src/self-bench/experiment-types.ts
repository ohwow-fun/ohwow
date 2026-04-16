/**
 * Experiment primitive for the self-improvement loop.
 *
 * An Experiment is the atomic unit the ExperimentRunner schedules and
 * executes. Every existing reliability check (E1 model demotion, E2
 * trigger watchdog, triangulation harness, fuzz-list-handlers) will
 * eventually be rewrapped as an Experiment implementation so the
 * runner can drive them uniformly and their findings accumulate in a
 * single ledger.
 *
 * The lifecycle the runner invokes per experiment per tick:
 *
 *   probe()    → ProbeResult   — run the actual check. Cheap, idempotent.
 *   judge()    → Verdict       — read the result + recent history, decide pass/warning/fail.
 *   intervene? → InterventionApplied | null   — optional: actually change config.
 *
 * The runner persists one Finding row per run regardless of verdict so
 * the ledger captures every probe, not just failing ones. "Pass" rows
 * are load-bearing — they're how the system knows something was
 * checked recently and doesn't need re-probing.
 *
 * Judges receive the recent finding history so they can make
 * decisions based on trends (e.g. "this is the Nth consecutive fail,
 * escalate from warning to fail") without each experiment
 * reimplementing history-reading.
 *
 * Interventions are the only place an experiment mutates the world.
 * They must return a structured InterventionApplied describing what
 * changed so future validation can measure effect. Experiments that
 * just measure things don't implement intervene at all.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';

/**
 * Category buckets for experiment organization and ledger filtering.
 * Aligned with the existing reliability surfaces so each experiment
 * maps cleanly to one category. 'validation' is a cross-cutting bucket
 * for finding rows produced by the validation framework (Phase 3) —
 * filter on it to see every accountability receipt regardless of
 * which experiment's intervention was being validated.
 */
export type ExperimentCategory =
  | 'model_health'
  | 'trigger_stability'
  | 'tool_reliability'
  | 'handler_audit'
  | 'prompt_calibration'
  | 'canary'
  | 'validation'
  | 'experiment_proposal'
  | 'business_outcome'
  | 'other';

/**
 * Verdicts a judge can return. 'error' is reserved for the runner
 * itself when probe/judge throws — experiments should not return
 * 'error' themselves; they return fail.
 */
export type Verdict = 'pass' | 'warning' | 'fail' | 'error';

/** Ledger row status. Lets a later finding supersede or revoke an earlier one. */
export type FindingStatus = 'active' | 'superseded' | 'revoked';

/**
 * Output of probe(). Contains the raw signal the judge needs and the
 * summary + evidence fields that land in the ledger row.
 *
 * - subject: what this probe is about (e.g. "qwen/qwen3.5-9b",
 *            "trigger:d1a924de...", "tool:local_write_file"). Nullable
 *            for system-wide probes that aren't tied to one subject.
 * - summary: one-line human-readable description. Shows up in the
 *            ledger row and in operator list surfaces.
 * - evidence: structured data the judge and downstream queries need.
 *             Landed as JSON in self_findings.evidence.
 */
export interface ProbeResult {
  subject?: string | null;
  summary: string;
  evidence: Record<string, unknown>;
}

/**
 * What an intervene() returned. Structured so validation can replay
 * "on date D we changed X to Y" later. Null return from intervene
 * means "judge verdict didn't warrant a change" — the ledger still
 * gets a row, just without intervention_applied set.
 */
export interface InterventionApplied {
  /** One-line human-readable description of what was changed. */
  description: string;
  /** Structured details for replay/validation. */
  details: Record<string, unknown>;
}

/**
 * Ledger row as read back by readRecentFindings. Mirrors the
 * self_findings table schema but uses camelCase + typed evidence.
 */
export interface Finding {
  id: string;
  experimentId: string;
  category: ExperimentCategory;
  subject: string | null;
  hypothesis: string | null;
  verdict: Verdict;
  summary: string;
  evidence: Record<string, unknown>;
  interventionApplied: InterventionApplied | null;
  ranAt: string;
  durationMs: number;
  status: FindingStatus;
  supersededBy: string | null;
  createdAt: string;
}

/**
 * Lightweight scheduler interface the runner exposes to
 * meta-experiments that need to modify peer cadences. Phase 4's
 * AdaptiveSchedulerExperiment uses this to stretch cadences on
 * pass streaks and pull them in on failures — the core mechanic
 * that makes probe budget follow actual signal instead of running
 * every experiment on a static schedule.
 *
 * Kept narrow on purpose: the meta-loop should not be able to
 * register/unregister peers, only adjust their next-run timestamps
 * and introspect their current state.
 */
export interface ExperimentScheduler {
  /**
   * Override the next-run timestamp for an experiment. Epoch ms.
   * No-op if the experimentId isn't registered. Values in the past
   * are clamped to "immediate" by the runner.
   */
  setNextRunAt(experimentId: string, timestampMs: number): void;
  /**
   * Snapshot of every registered experiment: id, category, cadence,
   * and current nextRunAt. Meta-experiments iterate this to pick
   * targets.
   */
  getRegisteredExperimentInfo(): Array<{
    id: string;
    name: string;
    category: ExperimentCategory;
    cadence: ExperimentCadence;
    nextRunAt: number;
  }>;
}

/**
 * Context passed to every experiment method by the runner. Gives
 * experiments access to the DB, the engine, a helper to read their
 * own recent findings for history-aware judgment, and (when the
 * runner has one) a scheduler reference for meta-experiments that
 * need to modify peer cadences.
 */
export interface ExperimentContext {
  db: DatabaseAdapter;
  /**
   * The resolved workspace row id used to scope SQL queries. After
   * daemon consolidation this is either the cloud workspace UUID
   * (when a license key is configured) or the 'local' sentinel.
   * NEVER equals the human-readable workspace slug — use
   * workspaceSlug for that.
   */
  workspaceId: string;
  /**
   * The human-readable workspace slug (e.g. 'default', 'avenued')
   * resolved from OHWOW_WORKSPACE / the workspace pointer / the
   * default-workspace fallback. Distinct from workspaceId because
   * consolidation rewrites workspaceId to the cloud UUID or 'local',
   * losing the operator-visible name. Experiments that need to
   * behave differently per workspace (e.g. business experiments that
   * only run on the GTM dogfood slot) match on workspaceSlug, not
   * workspaceId.
   *
   * Optional on this interface so test helpers that construct
   * contexts directly don't have to know about it — the runner
   * always populates it in production. Consumers that depend on it
   * must handle undefined with a safe fallback.
   */
  workspaceSlug?: string;
  engine: RuntimeEngine;
  /** Read recent findings for this experiment id (most recent first). */
  recentFindings(experimentId: string, limit?: number): Promise<Finding[]>;
  /**
   * Present when the ExperimentRunner built the context. Absent in
   * unit tests that construct contexts directly. Experiments that
   * need to modify peer cadences must null-check.
   */
  scheduler?: ExperimentScheduler;
  /**
   * Wall-clock ms at which the runner's start() was called for this
   * process. Daemon restart is a state boundary — probes that
   * aggregate recent findings (patch-loop-health, anything with a
   * multi-hour lookback) should floor their window at this value
   * and emit a warmup pass when the post-restart window is too
   * short to be meaningful. Absent in tests that build ctx directly.
   */
  runnerStartedAtMs?: number;
  /**
   * Piece 2 — surprise primitive. When the runner built the context
   * it attaches this closure so probe()/judge() can score a
   * hypothetical observation against the (experiment_id, subject)
   * baseline before deciding what to write. Returns the same novelty
   * dimensions Piece 1 injects into evidence.__novelty.
   *
   * Optional so test contexts that don't need it can stay minimal.
   */
  scoreSurprise?: (input: import('./surprise.js').ScoreSurpriseInput) => Promise<import('./surprise.js').SurpriseResult>;
}

/**
 * Cadence controls how often the runner invokes an experiment.
 *
 * - everyMs: interval between runs. 0 means "run only on boot."
 * - runOnBoot: if true, the first run fires at runner start; if false,
 *              the first run is now+everyMs so boot-time noise doesn't
 *              saturate the ledger.
 * - whenIdle: reserved for a future phase. Today the runner always
 *             runs regardless, since probe() is expected to be cheap.
 * - validationDelayMs: when this experiment implements validate(),
 *             how long after an intervention should the runner fire
 *             the validation check. Default 15 minutes.
 */
export interface ExperimentCadence {
  everyMs: number;
  runOnBoot?: boolean;
  whenIdle?: boolean;
  validationDelayMs?: number;
}

/**
 * Possible outcomes of a validation. 'held' means the intervention is
 * still in effect and the system state looks good; 'failed' means the
 * intervention rebounded (the same condition re-emerged or a new one
 * caused by the intervention); 'inconclusive' means we couldn't tell.
 */
export type ValidationOutcome = 'held' | 'failed' | 'inconclusive';

/** Lifecycle of a row in the experiment_validations table. */
export type ValidationStatus = 'pending' | 'completed' | 'skipped' | 'error';

/**
 * Result shape returned by an experiment's validate() method. The
 * runner turns this into a self_findings row in category='validation'.
 */
export interface ValidationResult {
  outcome: ValidationOutcome;
  summary: string;
  evidence: Record<string, unknown>;
}

/**
 * A pending validation row read out of experiment_validations by the
 * runner's due-queue processor.
 */
export interface PendingValidation {
  id: string;
  interventionFindingId: string;
  experimentId: string;
  baseline: Record<string, unknown>;
  validateAt: string;
  status: ValidationStatus;
  createdAt: string;
}

/**
 * The Experiment interface. An implementation is a class or plain
 * object exposing id, metadata, cadence, probe, judge, and optionally
 * intervene and validate. The runner owns scheduling, persistence,
 * error recovery, history, and validation queuing — the experiment
 * owns the probe, the decision, and the intervention + validation
 * logic.
 *
 * validate() is the Phase 3 accountability hook. When an experiment
 * implements it AND intervene() returns a non-null InterventionApplied
 * on a given run, the runner automatically enqueues a validation row
 * in experiment_validations. validate() fires ~validationDelayMs
 * after the intervention (default 15 minutes) and reads the
 * intervention's details as the baseline parameter. Its result lands
 * as a self_findings row in category='validation' with a verdict
 * mapped from the ValidationOutcome.
 */
export interface Experiment {
  id: string;
  name: string;
  category: ExperimentCategory;
  hypothesis: string;
  cadence: ExperimentCadence;

  probe(ctx: ExperimentContext): Promise<ProbeResult>;
  judge(result: ProbeResult, history: Finding[]): Verdict;
  intervene?(
    verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null>;
  validate?(
    baseline: Record<string, unknown>,
    ctx: ExperimentContext,
  ): Promise<ValidationResult>;
  /**
   * Phase 5 — automatic rollback. When validate() returns
   * outcome='failed' and the experiment implements this hook, the
   * runner calls rollback(baseline, ctx) to undo the intervention.
   * Takes the SAME baseline that was passed to validate() so the
   * rollback knows exactly what was changed. Returns a description
   * of what was reverted (for the ledger), or null if there was
   * nothing to undo (e.g. the failed state resolved itself between
   * validate and rollback).
   */
  rollback?(
    baseline: Record<string, unknown>,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null>;
  /**
   * Opt-in list of evidence keys the auto-followup validator should
   * treat as burn-down scalars (a decrease across the intervention is
   * read as "held"). When defined, replaces the runner's default
   * suffix-based heuristic (`_count`, `_pool`, `_backlog`, etc.) for
   * this experiment only.
   *
   * Pass an empty array to opt OUT entirely — the validator will treat
   * the experiment as having no measurable burn-down signal, so a flat
   * verdict resolves to `inconclusive` instead of `failed`. Use this
   * for experiments whose evidence happens to end in a burn-down
   * suffix but is actually a fluctuating observation (e.g.
   * agent-coverage-gap's `concerning_count`, intervention-audit's
   * `performative_count`) rather than a draining pool.
   *
   * Pass an explicit list (e.g. `['unclaimed_count']`) to declare
   * exactly which keys mean burn-down for this experiment, ignoring
   * any other suffix-matching keys in the same evidence blob.
   */
  burnDownKeys?: string[];
}

/**
 * Row shape the runner writes to self_findings. Helper for the store
 * module — consumers outside this package should use Finding.
 */
export interface NewFindingRow {
  experimentId: string;
  category: ExperimentCategory;
  subject: string | null;
  hypothesis: string | null;
  verdict: Verdict;
  summary: string;
  evidence: Record<string, unknown>;
  interventionApplied: InterventionApplied | null;
  ranAt: string;
  durationMs: number;
}
