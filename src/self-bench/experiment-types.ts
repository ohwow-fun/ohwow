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
 * maps cleanly to one category.
 */
export type ExperimentCategory =
  | 'model_health'
  | 'trigger_stability'
  | 'tool_reliability'
  | 'handler_audit'
  | 'prompt_calibration'
  | 'canary'
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
 * Context passed to every experiment method by the runner. Gives
 * experiments access to the DB, the engine, and a helper to read
 * their own recent findings for history-aware judgment.
 */
export interface ExperimentContext {
  db: DatabaseAdapter;
  workspaceId: string;
  engine: RuntimeEngine;
  /** Read recent findings for this experiment id (most recent first). */
  recentFindings(experimentId: string, limit?: number): Promise<Finding[]>;
}

/**
 * Cadence controls how often the runner invokes an experiment.
 *
 * - everyMs: interval between runs. 0 means "run only on boot."
 * - runOnBoot: if true, the first run fires at runner start; if false,
 *              the first run is now+everyMs so boot-time noise doesn't
 *              saturate the ledger.
 * - whenIdle: reserved for Phase 3. Today the runner always runs
 *             regardless, since probe() is expected to be cheap.
 */
export interface ExperimentCadence {
  everyMs: number;
  runOnBoot?: boolean;
  whenIdle?: boolean;
}

/**
 * The Experiment interface. An implementation is a class or plain
 * object exposing id, metadata, cadence, probe, judge, and optionally
 * intervene. The runner owns scheduling, persistence, error recovery,
 * and history — the experiment owns the probe and the decision.
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
