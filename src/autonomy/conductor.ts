/**
 * Conductor (Phase 5 of the autonomy retrofit).
 *
 * In-process loop that ticks at the same cadence as ImprovementScheduler
 * (default 1h). On every tick:
 *   1. Read the env flag `OHWOW_AUTONOMY_CONDUCTOR`. If !== '1', exit
 *      with reason 'flag-off'. Production behavior is dark-launched.
 *   2. Refuse to start if any Director arc is already open for the
 *      workspace ('arc-in-flight'). One arc at a time.
 *   3. Read pulse + ledger. Build a Picker closure that on every Director
 *      iteration re-reads the answered-inbox + pulse + ledger and returns
 *      the top RankedPhase as a PickerOutput. Returns null when the
 *      ranker is empty -> arc closes 'nothing-queued'.
 *   4. Open the arc with mode_of_invocation='loop-tick' and let
 *      `runArc` drive it.
 *
 * The executor is a STUB until Phase 6/7 swap in the
 * sub-orchestrator-backed real executor. The stub returns no-op rounds
 * so the arc closes cleanly and downstream persistence shapes are
 * exercised end-to-end.
 *
 * The Conductor never modifies ImprovementScheduler. It runs alongside.
 */
import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import {
  defaultDirectorIO,
  runArc,
  type ArcInput,
  type DirectorIO,
  type Picker,
  type PickerOutput,
} from './director.js';
import {
  listAnsweredUnresolvedFounderInbox,
  listOpenArcs,
  type ArcExitReason,
  type FounderInboxRecord,
} from './director-persistence.js';
import {
  rankNextPhase,
  readLedgerSnapshot,
  type LedgerSnapshot,
  type RankedPhase,
} from './ranker.js';
import { readFullPulse, type FullPulseSnapshot } from './pulse.js';
import type { RoundBrief, RoundExecutor, RoundReturn } from './types.js';

// ---- env flag ----------------------------------------------------------

export const CONDUCTOR_ENV_FLAG = 'OHWOW_AUTONOMY_CONDUCTOR';

export function isConductorEnabled(): boolean {
  return process.env[CONDUCTOR_ENV_FLAG] === '1';
}

// ---- stub executor (TODO(phase-6): swap for real sub-orchestrator) ----

/**
 * Stub executor used until Phase 6/7 wires the sub-orchestrator-backed
 * real executor. Plan returns continue with a stub body, impl returns
 * continue with no commits, qa returns passed.
 *
 * TODO(phase-6): swap for sub-orchestrator-backed executor (round-runner +
 * sub-orchestrator.ts) once the evaluation harness gates the flag flip.
 */
export class StubConductorExecutor implements RoundExecutor {
  async run(brief: RoundBrief): Promise<RoundReturn> {
    if (brief.kind === 'qa') {
      return {
        status: 'continue',
        summary: 'qa stub: no-op pass',
        findings_written: [],
        commits: [],
        evaluation: {
          verdict: 'passed',
          criteria: [
            { criterion: 'stub executor passthrough', outcome: 'passed' },
          ],
          test_commits: [],
          fix_commits: [],
        },
      };
    }
    return {
      status: 'continue',
      summary: `${brief.kind} stub: no-op continue`,
      next_round_brief: `stub ${brief.kind} brief for ${brief.trio_id}`,
      findings_written: [],
      commits: [],
    };
  }
}

export function defaultMakeStubExecutor(): RoundExecutor {
  return new StubConductorExecutor();
}

// ---- public API --------------------------------------------------------

export interface ConductorDeps {
  db: DatabaseAdapter;
  io: DirectorIO;
  workspace_id: string;
  /** Factory for the executor used by trios; allows test injection. */
  makeExecutor: () => RoundExecutor;
  /** Override for tests / debugging. Defaults to `readFullPulse`. */
  pulseReader?: typeof readFullPulse;
  /** Override for tests / debugging. Defaults to `readLedgerSnapshot`. */
  ledgerReader?: typeof readLedgerSnapshot;
  /** Test hook: pin "now" for cadence / novelty windows. */
  refTimeMs?: number;
}

export interface ConductorTickResult {
  ran: boolean;
  arc_id?: string;
  arc_status?: 'closed' | 'aborted';
  exit_reason?: ArcExitReason;
  /** When ran=false: 'nothing-queued' | 'arc-in-flight' | 'flag-off' | error msg. */
  reason?: string;
}

function genPhaseId(workspace_id: string, mode: string, seq: number): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const ws = workspace_id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
  return `${ws}-${stamp}-${mode}-${seq}`;
}

/**
 * Stable per-pick key. Mirrors `ranker.candidateKey` but lives here too
 * so the conductor doesn't need to import a private ranker helper.
 * Bug #1 (Phase 6.5): the picker tracks already-picked keys in this arc
 * to prevent the same source candidate from running back-to-back inside
 * one arc. Cadence penalty alone (-50) doesn't suppress an approval at
 * 100+age_h, so the spec-intent of "one phase per source per arc" was
 * not enforced. Keys are seeded by every successful pick, including
 * founder-answer (which still gets +200 priority but cannot stack on
 * the same inbox row).
 */
function pickedKey(p: RankedPhase): string {
  return `${p.mode}|${p.source}|${p.source_id ?? ''}`;
}

/**
 * Build the Picker closure that the Director will call on every iteration.
 * Re-reads inbox / pulse / ledger each time so a long-running arc sees
 * fresh signals between phases.
 *
 * Note: Phase 4's Director already lifts `newly_answered` rows out of the
 * inbox before calling the picker, so this closure does NOT need to
 * re-poll for them itself — it just consumes `input.newly_answered`.
 *
 * Phase 6.5 additions:
 *   - `picked_keys` (Bug #1): per-arc memory of every (mode, source,
 *     source_id) the picker has already returned. Filters them out before
 *     returning the next pick.
 *   - `seedAnsweredQueue` (Bug #2): the conductor pre-fetches workspace-
 *     wide answered inbox rows BEFORE entering `runArc` and seeds them
 *     here so the FIRST picker call sees answers that originated in a
 *     prior (now-closed) arc.
 */
interface ConductorPickerOpts {
  /**
   * Workspace-wide answered inbox rows pre-fetched by the conductor.
   * Drained on the first picker call and merged into the Director's
   * own per-arc `newly_answered` so the first phase resumes them.
   */
  seedAnswered?: FounderInboxRecord[];
}

function buildConductorPicker(
  deps: ConductorDeps,
  opts: ConductorPickerOpts = {},
): Picker {
  const pulseReader = deps.pulseReader ?? readFullPulse;
  const ledgerReader = deps.ledgerReader ?? readLedgerSnapshot;
  let seq = 0;
  const picked_keys = new Set<string>();
  let seedAnsweredPending: FounderInboxRecord[] = opts.seedAnswered ?? [];

  return async ({ newly_answered }) => {
    seq += 1;
    let pulse: FullPulseSnapshot;
    let ledger: LedgerSnapshot;
    try {
      pulse = await pulseReader(deps.db, deps.workspace_id);
    } catch (err) {
      logger.warn(
        { workspace_id: deps.workspace_id, err: (err as Error).message },
        'conductor.pulse.read.failed',
      );
      return null;
    }
    try {
      ledger = await ledgerReader(deps.db, deps.workspace_id);
    } catch (err) {
      logger.warn(
        { workspace_id: deps.workspace_id, err: (err as Error).message },
        'conductor.ledger.read.failed',
      );
      ledger = { recent_phase_reports: [], recent_findings: [] };
    }

    // Merge seeded cross-arc answers (drained once) with the Director's
    // per-arc newly_answered. De-dupe by id.
    let mergedAnswered = newly_answered;
    if (seedAnsweredPending.length > 0) {
      const seen = new Set(newly_answered.map((r) => r.id));
      const merged = [...newly_answered];
      for (const row of seedAnsweredPending) {
        if (!seen.has(row.id)) {
          merged.push(row);
          seen.add(row.id);
        }
      }
      mergedAnswered = merged;
      // Resolve the seeded rows so they don't re-surface on the next
      // picker call (the in-arc poll won't see them either; arc_id
      // doesn't match this new arc).
      for (const row of seedAnsweredPending) {
        try {
          await deps.db
            .from('founder_inbox')
            .update({ status: 'resolved' })
            .eq('id', row.id);
        } catch (err) {
          logger.warn(
            {
              workspace_id: deps.workspace_id,
              inbox_id: row.id,
              err: (err as Error).message,
            },
            'conductor.seed_answered.resolve.failed',
          );
        }
      }
      seedAnsweredPending = [];
    }

    const ranked: RankedPhase[] = rankNextPhase({
      pulse,
      ledger,
      newly_answered: mergedAnswered,
      refTimeMs: deps.refTimeMs,
    });

    // Bug #1 (Phase 6.5): drop already-picked keys for this arc so the
    // same approval / deal / trigger doesn't run back-to-back.
    const filtered = ranked.filter((c) => !picked_keys.has(pickedKey(c)));
    if (filtered.length === 0) return null;

    const top = filtered[0];
    picked_keys.add(pickedKey(top));
    const out: PickerOutput = {
      phase_id: genPhaseId(deps.workspace_id, top.mode, seq),
      mode: top.mode,
      goal: top.goal,
      initial_plan_brief: top.initial_plan_brief,
    };
    return out;
  };
}

export async function conductorTick(
  deps: ConductorDeps,
): Promise<ConductorTickResult> {
  if (!isConductorEnabled()) {
    return { ran: false, reason: 'flag-off' };
  }

  try {
    const open = await listOpenArcs(deps.db, deps.workspace_id);
    if (open.length > 0) {
      return { ran: false, reason: 'arc-in-flight' };
    }
  } catch (err) {
    logger.warn(
      { workspace_id: deps.workspace_id, err: (err as Error).message },
      'conductor.open_arcs.read.failed',
    );
    return { ran: false, reason: `open-arcs-read-failed: ${(err as Error).message}` };
  }

  // Pre-read pulse + ledger for the thesis line; the picker re-reads on
  // every iteration so a long-running arc sees fresh state.
  const pulseReader = deps.pulseReader ?? readFullPulse;
  let pulse: FullPulseSnapshot;
  try {
    pulse = await pulseReader(deps.db, deps.workspace_id);
  } catch (err) {
    return { ran: false, reason: `pulse-failed: ${(err as Error).message}` };
  }

  const ledgerReader = deps.ledgerReader ?? readLedgerSnapshot;
  let ledger: LedgerSnapshot = {
    recent_phase_reports: [],
    recent_findings: [],
  };
  try {
    ledger = await ledgerReader(deps.db, deps.workspace_id);
  } catch (err) {
    logger.warn(
      { workspace_id: deps.workspace_id, err: (err as Error).message },
      'conductor.ledger.preview.failed',
    );
  }

  // Bug #2 (Phase 6.5): pre-fetch workspace-wide answered+unresolved
  // inbox rows so the first picker call can resume answers whose arc
  // closed before the answer landed (e.g. inbox-cap exit). The in-arc
  // `listAnsweredFounderInbox(arc_id)` still handles within-arc
  // answers; this seeds the FIRST picker call only.
  let seedAnswered: FounderInboxRecord[] = [];
  try {
    seedAnswered = await listAnsweredUnresolvedFounderInbox(
      deps.db,
      deps.workspace_id,
    );
  } catch (err) {
    logger.warn(
      { workspace_id: deps.workspace_id, err: (err as Error).message },
      'conductor.answered_inbox.read.failed',
    );
  }

  // Probe the ranker once to pick the thesis line. The Director will
  // re-call the picker on its first iteration (which will re-read pulse
  // / ledger / newly_answered) and may return a different RankedPhase if
  // any of those moved between this probe and the picker call. That's
  // fine — the thesis is a label, not a contract.
  const probe = rankNextPhase({
    pulse,
    ledger,
    newly_answered: seedAnswered,
    refTimeMs: deps.refTimeMs,
  });
  const thesis = probe.length > 0
    ? `autonomous: ${probe[0].goal}`
    : 'autonomous: scan for next-best phase';

  const picker = buildConductorPicker(deps, { seedAnswered });
  const executor = deps.makeExecutor();

  const arcInput: ArcInput = {
    workspace_id: deps.workspace_id,
    thesis,
    mode_of_invocation: 'loop-tick',
  };

  try {
    const result = await runArc(arcInput, picker, executor, deps.db, deps.io);
    return {
      ran: true,
      arc_id: result.arc_id,
      arc_status: result.status,
      exit_reason: result.exit_reason,
    };
  } catch (err) {
    logger.error(
      { workspace_id: deps.workspace_id, err: (err as Error).message },
      'conductor.arc.run.failed',
    );
    return { ran: false, reason: `arc-run-failed: ${(err as Error).message}` };
  }
}

export interface StartConductorLoopOptions extends ConductorDeps {
  intervalMs: number;
  /** Optional AbortSignal; aborting also clears the interval. */
  signal?: AbortSignal;
}

export interface ConductorLoopHandle {
  stop: () => void;
}

export function startConductorLoop(
  opts: StartConductorLoopOptions,
): ConductorLoopHandle {
  const { intervalMs, signal, ...deps } = opts;
  let stopped = false;
  let inflight: Promise<void> | null = null;

  const tickOnce = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const r = await conductorTick(deps);
        logger.info(
          {
            workspace_id: deps.workspace_id,
            ran: r.ran,
            arc_id: r.arc_id,
            arc_status: r.arc_status,
            exit_reason: r.exit_reason,
            reason: r.reason,
          },
          'conductor.tick',
        );
      } catch (err) {
        logger.error(
          { workspace_id: deps.workspace_id, err: (err as Error).message },
          'conductor.tick.threw',
        );
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  const timer = setInterval(() => {
    void tickOnce();
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  if (signal) {
    if (signal.aborted) {
      clearInterval(timer);
      stopped = true;
    } else {
      signal.addEventListener('abort', () => {
        stopped = true;
        clearInterval(timer);
      });
    }
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

// Re-export the `defaultDirectorIO` builder so callers wiring the
// conductor don't need a second import path.
export { defaultDirectorIO };
