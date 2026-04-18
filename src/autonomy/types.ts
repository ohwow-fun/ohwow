/**
 * Shared types for the autonomy stack (Conductor / Director / Phase / Trio /
 * Round). Phase 2 implements only the Trio primitive; the other tiers consume
 * these same types in later phases. See
 * `docs/autonomy-architecture.md` for the design contract.
 */

export type Mode = 'revenue' | 'polish' | 'plumbing' | 'tooling';

export type RoundKind = 'plan' | 'impl' | 'qa';

export type RoundStatus = 'continue' | 'needs-input' | 'blocked' | 'done';

export type TrioOutcome =
  | 'successful'
  | 'regressed'
  | 'blocked'
  | 'awaiting-founder'
  | 'in-flight';

/**
 * QA-only verdict. Distinct from `RoundStatus` because the trio's outcome
 * derives from `qa.evaluation.verdict`, NOT from `qa.status` — a QA round
 * can return `status='continue'` while still landing a `failed-fixed`
 * verdict, and the trio is `successful` either way.
 */
export type QaVerdict = 'passed' | 'failed-fixed' | 'failed-escalate';

export interface RoundEvaluationCriterion {
  criterion: string;
  outcome: 'passed' | 'failed' | 'untestable';
  note?: string;
}

export interface RoundEvaluation {
  verdict: QaVerdict;
  criteria: RoundEvaluationCriterion[];
  test_commits: string[];
  fix_commits: string[];
}

export interface RoundReturn {
  status: RoundStatus;
  /** <=5 lines; logged to phase_rounds.summary. Long summaries are truncated with a warning rather than thrown. */
  summary: string;
  /** Brief for the next round; required when the trio runner is going to spawn another round. */
  next_round_brief?: string;
  /** self_findings.id rows the round wrote */
  findings_written: string[];
  /** Short SHAs the round committed; empty for plan rounds and code-less revenue rounds */
  commits: string[];
  /** QA rounds only */
  evaluation?: RoundEvaluation;
}

export interface RoundBrief {
  trio_id: string;
  kind: RoundKind;
  mode: Mode;
  /** One sentence */
  goal: string;
  /** Full instructions for the round (mode lens prose, plan output, etc.) */
  body: string;
  /** plan -> undefined; impl <- plan return; qa <- impl return */
  prior?: RoundReturn;
}

/**
 * Injection surface for the Trio primitive. Phase 3 will adapt this around
 * `src/orchestrator/sub-orchestrator.ts`. Phase 2 only uses scripted stubs.
 */
export interface RoundExecutor {
  run(brief: RoundBrief): Promise<RoundReturn>;
}

/**
 * Polled at each round boundary (NOT mid-round). The Conductor will feed
 * pulse regressions through this surface in Phase 5; Phase 2 supports it
 * so tests can prove the abort plumbing without waiting on Phase 5.
 */
export interface AbortSignalSource {
  poll(): { reason: string } | null;
}

export interface TrioInput {
  trio_id: string;
  mode: Mode;
  goal: string;
  /** Body for the plan round */
  initial_plan_brief: string;
  /** Optional persistence hook; called after each round completes (Phase 3 wires DB writes here) */
  onRoundComplete?: (brief: RoundBrief, ret: RoundReturn) => Promise<void>;
  /** Optional founder-question hook for status==='needs-input' */
  onFounderQuestion?: (q: {
    round: RoundKind;
    brief: RoundBrief;
    ret: RoundReturn;
  }) => Promise<void>;
  /** Optional abort source polled between rounds */
  abort?: AbortSignalSource;
  /** Wall-clock cap in minutes; defaults to 90 */
  max_minutes?: number;
}

export interface TrioRoundRecord {
  kind: RoundKind;
  brief: RoundBrief;
  ret: RoundReturn;
  started_at: string;
  ended_at: string;
}

export interface TrioResult {
  trio_id: string;
  outcome: TrioOutcome;
  rounds: TrioRoundRecord[];
  /** Populated when outcome !== 'successful' */
  reason?: string;
  /** QA evaluation block, lifted for phase orchestrator consumption */
  qa_evaluation?: RoundEvaluation;
}
