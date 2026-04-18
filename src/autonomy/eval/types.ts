/**
 * Shared types for the autonomy evaluation harness (Phase 6).
 *
 * A "scenario" is: a known pulse + ledger seed → run N Conductor ticks →
 * assert structured properties of the resulting trajectory. Scenarios
 * produce a deterministic ASCII transcript that is diffed against a
 * committed golden file. The structural assertions catch sneaky
 * regressions where the transcript happens to match but a key property
 * (which arc opened, which exit reason, which founder question carried
 * the right phase id) silently changed.
 *
 * The harness drives `conductorTick` directly with a fake clock and a
 * deterministic id factory; nothing here calls into the LLM. A
 * `RunOptions.makeExecutor` seam is left open so a future phase can swap
 * in a real-LLM executor for opt-in deeper evaluation, without changing
 * any scenario.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ConductorTickResult } from '../conductor.js';
import type { Mode, RoundExecutor } from '../types.js';

// ----------------------------------------------------------------------------
// Context the harness threads through every step
// ----------------------------------------------------------------------------

export interface ScenarioContext {
  workspace_id: string;
  /** Returns the harness's *fake* clock; tests advance via `advance()`. */
  now: () => Date;
  /** Bump the fake clock forward by the given milliseconds. */
  advance: (ms: number) => void;
  /** Stable id factory: `nextId('arc')` -> `arc_001`, `nextId('arc')` -> `arc_002`. */
  nextId: (prefix: string) => string;
  db: DatabaseAdapter;
}

// ----------------------------------------------------------------------------
// Declarative seed shapes (NOT free SQL — narrow on purpose)
// ----------------------------------------------------------------------------

export type FindingVerdict = 'pass' | 'warning' | 'fail' | 'error';

export type InboxStatus = 'open' | 'answered' | 'resolved';

export type PriorPhaseStatus =
  | 'phase-closed'
  | 'phase-partial'
  | 'phase-aborted'
  | 'phase-blocked-on-founder';

export interface SeedApproval {
  id?: string;
  subject: string;
  /** Hours since the approval row was created. */
  age_hours: number;
  mode: 'revenue';
}

export interface SeedDeal {
  id?: string;
  /** Days since the deal was last updated. */
  idle_days: number;
  /** Stage name (must NOT match /closed/i to count as rotting). */
  stage: string;
  expected_value_cents?: number;
}

export interface SeedQualifiedContact {
  id?: string;
  name?: string;
  /** Hours since the `x:qualified` event landed. */
  qualified_hours_ago: number;
}

export interface SeedFailingTrigger {
  id?: string;
  /** Trigger class label (e.g. `cron-x-intel`). */
  class: string;
  /** Consecutive failure count; the pulse threshold is 3. */
  failure_count: number;
  last_failure_hours_ago: number;
}

export interface SeedFinding {
  id?: string;
  category: string;
  verdict: FindingVerdict;
  subject?: string;
  hours_ago: number;
}

export interface SeedBusinessVitals {
  mrr_cents?: number;
  pipeline_count?: number;
  daily_llm_cost_cents?: number;
  pending_approvals_count?: number;
}

export interface SeedFounderInbox {
  id?: string;
  arc_id?: string;
  phase_id?: string;
  mode: Mode;
  blocker: string;
  status: InboxStatus;
  answer?: string;
  asked_hours_ago: number;
}

export interface SeedPriorPhaseReport {
  id?: string;
  arc_id?: string;
  phase_id?: string;
  mode: Mode;
  /** Same provenance string the ranker emits, e.g. `fire approval ap_001 [source=approval; id=ap_001]`. */
  goal_source: string;
  status: PriorPhaseStatus;
  hours_ago: number;
  /**
   * When set, the synthetic parent arc is left in `status='open'`
   * (instead of the default `closed`). Used by Phase 6.7's
   * restart-mid-arc scenario to leave an arc open with a persisted
   * phase_id the new picker must dedupe via `reconstructPickedKeys`.
   */
  parent_arc_open?: boolean;
}

export interface SeedSpec {
  approvals?: SeedApproval[];
  deals?: SeedDeal[];
  contacts_qualified?: SeedQualifiedContact[];
  failing_triggers?: SeedFailingTrigger[];
  findings?: SeedFinding[];
  business_vitals?: SeedBusinessVitals;
  founder_inbox?: SeedFounderInbox[];
  prior_phase_reports?: SeedPriorPhaseReport[];
}

// ----------------------------------------------------------------------------
// Scenario primitives
// ----------------------------------------------------------------------------

export type ScenarioStepKind =
  | 'tick'
  | 'advance'
  | 'seed'
  | 'answer-founder'
  | 'restart-pick-once';

export interface ScenarioStep {
  kind: ScenarioStepKind;
  /** Optional human-readable label that shows up in the transcript. */
  note?: string;
  /** `seed` only — extra rows applied between ticks. */
  spec?: SeedSpec;
  /** `advance` only — milliseconds to bump the fake clock. */
  ms?: number;
  /** `answer-founder` only — id of an inbox row to answer. */
  founder_inbox_id?: string;
  /** `answer-founder` only — answer text to record. */
  founder_answer?: string;
  /**
   * `restart-pick-once` only — id of an OPEN arc to attach a fresh
   * picker to. The harness builds a fresh in-memory picker (no
   * picked_keys), runs `reconstructPickedKeys(arc_id)` to rebuild from
   * the persisted phase_ids, then invokes the picker once. The pick
   * (or null) is recorded for the assertion. No phase actually runs.
   * Phase 6.7 (Deliverable A): this is the closest the harness comes to
   * simulating "daemon crashed mid-arc and restarted." We don't try to
   * reproduce a full crash because the harness has no concept of a
   * persistent picker process; the property-under-test is "a fresh
   * picker against an existing arc dedupes via the persisted phase_ids."
   */
  restart_arc_id?: string;
}

export interface ScenarioRestartPick {
  picked: boolean;
  phase_id?: string;
  mode?: string;
  goal?: string;
  reason?: string;
}

export interface ScenarioPhaseSummary {
  phase_id: string;
  mode: string;
  status: string;
  trios: number;
  goal: string;
}

export interface ScenarioArcSummary {
  arc_id: string;
  status: string;
  exit_reason: string;
  phases: ScenarioPhaseSummary[];
}

export interface ScenarioInboxChange {
  id: string;
  status: string;
}

export interface ScenarioStepRecord {
  step_index: number;
  kind: ScenarioStepKind;
  note?: string;
  tick_result?: ConductorTickResult;
  arc_summary?: ScenarioArcSummary;
  inbox_changes?: ScenarioInboxChange[];
  /** `restart-pick-once` only. */
  restart_pick?: ScenarioRestartPick;
}

export interface ScenarioFinals {
  open_arcs: number;
  closed_arcs: number;
  aborted_arcs: number;
  total_phase_reports: number;
  open_founder_inbox: number;
}

export interface ScenarioTranscript {
  scenario: string;
  describe: string;
  initial_seed_summary: string;
  steps: ScenarioStepRecord[];
  finals: ScenarioFinals;
}

export interface ScenarioAssertionContext {
  db: DatabaseAdapter;
  workspace_id: string;
}

export type ScenarioAssertion = (
  transcript: ScenarioTranscript,
  ctx: ScenarioAssertionContext,
) => Promise<void>;

export interface Scenario {
  /** File-safe slug used to look up the golden file. */
  name: string;
  /** 1-2 sentences explaining what this scenario proves. */
  describe: string;
  initial_seed: SeedSpec;
  steps: ScenarioStep[];
  /** Structural assertions; transcript diff is the primary check. */
  assertions: ScenarioAssertion[];
  /**
   * Optional per-scenario executor factory. Default is the
   * deterministic stub (all-pass). Override when a scenario needs to
   * exercise a specific round-return shape (e.g. needs-input to
   * trigger the founder inbox path). The factory must return a NEW
   * executor each call so per-tick state stays isolated; if the
   * scenario needs persistent state across ticks, close over a
   * module-scoped instance and return it.
   */
  makeExecutor?: () => import('../types.js').RoundExecutor;
}

// ----------------------------------------------------------------------------
// Run-level options
// ----------------------------------------------------------------------------

export interface RunOptions {
  /**
   * Override the executor factory. Default: a deterministic stub that
   * passes every round. The seam exists so a future phase can register a
   * real-LLM executor behind `OHWOW_AUTONOMY_EVAL_REAL=1` without
   * touching the harness or any scenario.
   */
  makeExecutor?: () => RoundExecutor;
  /** Silence the project logger during runs. Default: true. */
  silent?: boolean;
}

export interface RunAllResult {
  pass: string[];
  fail: Array<{ name: string; reason: string; diff?: string }>;
  /** Names of scenarios whose golden was rewritten on this run. */
  updated?: string[];
  duration_ms: number;
}
