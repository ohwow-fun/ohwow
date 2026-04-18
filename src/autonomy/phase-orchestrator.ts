/**
 * Phase orchestrator — runs 1 to 3 Trios under a single coherent goal +
 * mode, persists every trio + round to SQLite (`phase_trios`,
 * `phase_rounds`), and returns the structured 5-line phase report from
 * `docs/autonomy-architecture.md` "The Phase contract".
 *
 * Phase 3 of the autonomy retrofit. Director (Phase 4) and Conductor
 * (Phase 5) are not wired here — the SHA / pulse / inbox slots in the
 * report are intentionally stubbed and filled by Phase 4.
 *
 * Control flow per trio:
 *   - Successful trio  -> phase-closed (we deliberately stop after the
 *                         first successful trio; multi-trio phases are
 *                         reserved for re-plans after regression).
 *   - Regressed trio   -> re-plan tighter (default) or close-partial,
 *                         per `on_regression`.
 *   - Blocked trio     -> phase-aborted (the trio raised an abort reason
 *                         that should propagate to the phase).
 *   - Awaiting-founder -> phase-blocked-on-founder (Phase 4 hook routes
 *                         the question to `founder_inbox`).
 *
 * Wall-clock cap is checked at trio boundaries (between trios), not
 * mid-trio. The trio primitive has its own per-trio cap.
 */

import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { runTrio } from './trio.js';
import {
  writeTrio,
  writeRound,
  updateTrioOutcome,
} from './persistence.js';
import type {
  AbortSignalSource,
  Mode,
  RoundBrief,
  RoundExecutor,
  RoundReturn,
  TrioInput,
  TrioOutcome,
  TrioResult,
} from './types.js';

const DEFAULT_MAX_TRIOS = 3;
const DEFAULT_MAX_MINUTES = 180;

export interface PhaseInput {
  phase_id: string;
  workspace_id: string;
  mode: Mode;
  /** One sentence */
  goal: string;
  initial_plan_brief: string;
  /** Default 3 */
  max_trios?: number;
  /**
   * When a trio comes back 'regressed', the orchestrator may re-plan
   * with a tightened brief. Default 'replan-tighter'.
   */
  on_regression?: 'replan-tighter' | 'close-partial';
  /** Phase-level abort source; passed through to each trio */
  abort?: AbortSignalSource;
  /** Phase-level wall-clock cap. Default 180 minutes. */
  max_minutes?: number;
  /** Optional founder-question hook; Phase 4 wires it to founder_inbox. */
  onFounderQuestion?: TrioInput['onFounderQuestion'];
}

export type PhaseStatus =
  | 'phase-closed'
  | 'phase-partial'
  | 'phase-blocked-on-founder'
  | 'phase-aborted';

export interface PhaseResult {
  phase_id: string;
  status: PhaseStatus;
  trios: TrioResult[];
  /** The 5-line report block from the spec, ASCII only. */
  report: string;
  started_at: string;
  ended_at: string;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeAscii(s: string): string {
  // Replace non-ASCII with a space, collapse, trim. Used on goal +
  // qa-failure reasons so the report stays ASCII per the spec.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
}

function nextDecisionFor(status: PhaseStatus): string {
  switch (status) {
    case 'phase-closed':
      return 'arc-stop';
    case 'phase-partial':
      return 'continue same goal';
    case 'phase-blocked-on-founder':
      return 'founder';
    case 'phase-aborted':
      return 'abort';
  }
}

/**
 * Build the tightened plan brief for the next trio when the previous one
 * regressed. Appends the regression reason and any failed QA criteria so
 * the next plan round has the failure context in front of it.
 */
function tighterBriefFor(
  prevBrief: string,
  prev: TrioResult,
): string {
  const lines: string[] = [prevBrief, ''];
  lines.push('## Re-plan after regression');
  lines.push(
    `Previous trio (${prev.trio_id}) outcome: regressed${prev.reason ? ` - ${sanitizeAscii(prev.reason)}` : ''}.`,
  );
  const failedCriteria = prev.qa_evaluation?.criteria.filter(
    (c) => c.outcome === 'failed',
  );
  if (failedCriteria && failedCriteria.length > 0) {
    lines.push('Failed QA criteria:');
    for (const c of failedCriteria) {
      const note = c.note ? ` (${sanitizeAscii(c.note)})` : '';
      lines.push(`- ${sanitizeAscii(c.criterion)}${note}`);
    }
  }
  lines.push(
    'Tighten scope. Address each failed criterion explicitly before adding new work.',
  );
  return lines.join('\n');
}

/** SHA / pulse / inbox slots are stubbed in Phase 3; Director (Phase 4) populates them. */
function buildReport(
  input: PhaseInput,
  status: PhaseStatus,
  trios: TrioResult[],
  totalRounds: number,
): string {
  const goal = sanitizeAscii(input.goal);
  const trioOutcomes = trios.map((t) => t.outcome).join(',');
  const lines = [
    `PHASE: ${input.phase_id} - ${input.mode} - ${goal}`,
    `STATUS: ${status}`,
    `TRIOS: ${trios.length} (${trioOutcomes})`,
    `SHAS: runtime <none for now>; cloud <none for now>`,
    `DELTA: pulse <skipped in Phase 3>; ledger trios=${trios.length},rounds=${totalRounds}; inbox +0`,
    `NEXT: ${nextDecisionFor(status)}`,
  ];
  return lines.join('\n');
}

/**
 * Decide the phase status given the latest trio outcome and the
 * orchestrator state. `phase-partial` here means "regressed and we ran
 * out of retries" or "regressed and on_regression='close-partial'".
 */
function statusForTrio(
  outcome: TrioOutcome,
  onRegression: 'replan-tighter' | 'close-partial',
  isLastAllowed: boolean,
): PhaseStatus | 'continue' {
  switch (outcome) {
    case 'successful':
      return 'phase-closed';
    case 'awaiting-founder':
      return 'phase-blocked-on-founder';
    case 'blocked':
      return 'phase-aborted';
    case 'regressed':
      if (onRegression === 'close-partial') return 'phase-partial';
      return isLastAllowed ? 'phase-partial' : 'continue';
    case 'in-flight':
      // Defensive: a finished TrioResult should never carry 'in-flight'.
      return 'phase-aborted';
  }
}

// ----------------------------------------------------------------------------
// Main entry
// ----------------------------------------------------------------------------

export async function runPhase(
  input: PhaseInput,
  executor: RoundExecutor,
  db: DatabaseAdapter,
): Promise<PhaseResult> {
  const startedAtIso = nowIso();
  const startedAtMs = Date.now();
  const maxTrios = input.max_trios ?? DEFAULT_MAX_TRIOS;
  const maxMinutes = input.max_minutes ?? DEFAULT_MAX_MINUTES;
  const onRegression = input.on_regression ?? 'replan-tighter';

  logger.info(
    {
      phase_id: input.phase_id,
      workspace_id: input.workspace_id,
      mode: input.mode,
      goal: input.goal,
      max_trios: maxTrios,
    },
    'phase.start',
  );

  const trios: TrioResult[] = [];
  let currentPlanBrief = input.initial_plan_brief;
  let status: PhaseStatus = 'phase-aborted'; // overwritten below
  let earlyExitReason: string | null = null;

  for (let i = 0; i < maxTrios; i++) {
    const trioId = `${input.phase_id}-t${i + 1}`;
    const isLastAllowed = i === maxTrios - 1;

    // ---- phase-level abort check at trio boundary ----------------------
    const phaseAbort = input.abort?.poll();
    if (phaseAbort) {
      status = 'phase-aborted';
      earlyExitReason = phaseAbort.reason;
      logger.warn(
        { phase_id: input.phase_id, reason: earlyExitReason },
        'phase.abort.pre-trio',
      );
      break;
    }

    // ---- phase-level wall-clock check ----------------------------------
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs > maxMinutes * 60_000) {
      status = 'phase-aborted';
      earlyExitReason = `phase_wall_clock_exceeded_${maxMinutes}m`;
      logger.warn(
        { phase_id: input.phase_id, elapsed_ms: elapsedMs, max_minutes: maxMinutes },
        'phase.abort.wall-clock',
      );
      break;
    }

    // ---- run the trio --------------------------------------------------
    const trioStartedAt = nowIso();
    let trioRowWritten = false;
    let roundIdx = 0;

    const onRoundComplete = async (brief: RoundBrief, ret: RoundReturn) => {
      try {
        // Persist the trio row on the very first round of this trio so
        // FK-style references from phase_rounds.trio_id are valid before
        // we insert any round row.
        if (!trioRowWritten) {
          await writeTrio(db, {
            id: trioId,
            phase_id: input.phase_id,
            workspace_id: input.workspace_id,
            mode: input.mode,
            outcome: 'in-flight',
            started_at: trioStartedAt,
          });
          trioRowWritten = true;
        }
        roundIdx += 1;
        const roundId = `${trioId}-r${roundIdx}`;
        const ended_at = nowIso();
        await writeRound(db, {
          id: roundId,
          trio_id: trioId,
          kind: brief.kind,
          brief,
          ret,
          started_at: trioStartedAt, // approximate; trio.ts stamps the round-level
          ended_at,
        });
      } catch (err) {
        logger.error(
          {
            phase_id: input.phase_id,
            trio_id: trioId,
            kind: brief.kind,
            err: (err as Error).message,
          },
          'phase.persist.round.error',
        );
        // Persistence errors must not crash the trio; the orchestrator
        // logs and continues. The forensic record is best-effort.
      }
    };

    const trioInput: TrioInput = {
      trio_id: trioId,
      mode: input.mode,
      goal: input.goal,
      initial_plan_brief: currentPlanBrief,
      onRoundComplete,
      onFounderQuestion: input.onFounderQuestion,
      abort: input.abort,
    };

    const result = await runTrio(trioInput, executor);
    trios.push(result);

    // Update the trio row with the final outcome (only if writeTrio
    // managed to run — i.e. at least one round happened).
    if (trioRowWritten) {
      try {
        await updateTrioOutcome(db, {
          id: trioId,
          outcome: result.outcome,
          ended_at: nowIso(),
        });
      } catch (err) {
        logger.error(
          {
            phase_id: input.phase_id,
            trio_id: trioId,
            err: (err as Error).message,
          },
          'phase.persist.trio.error',
        );
      }
    }

    // ---- decide phase status from trio outcome -------------------------
    const decision = statusForTrio(result.outcome, onRegression, isLastAllowed);

    if (decision === 'continue') {
      // Regressed trio with retries left. Build tighter brief and loop.
      currentPlanBrief = tighterBriefFor(currentPlanBrief, result);
      logger.info(
        { phase_id: input.phase_id, trio_id: trioId, regressed: true },
        'phase.replan',
      );
      continue;
    }

    status = decision;
    break;
  }

  const endedAtIso = nowIso();
  const totalRounds = trios.reduce((acc, t) => acc + t.rounds.length, 0);
  const report = buildReport(input, status, trios, totalRounds);

  logger.info(
    {
      phase_id: input.phase_id,
      status,
      trios: trios.length,
      rounds: totalRounds,
      reason: earlyExitReason,
    },
    'phase.end',
  );

  return {
    phase_id: input.phase_id,
    status,
    trios,
    report,
    started_at: startedAtIso,
    ended_at: endedAtIso,
  };
}
