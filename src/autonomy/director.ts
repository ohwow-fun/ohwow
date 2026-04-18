/**
 * Director — runs one arc (1 to 6 phases) under a budget envelope, picking
 * the next phase from an injectable picker, executing it through the phase
 * orchestrator, persisting a 5-line phase report per phase, and deciding
 * continue vs. stop based on budget + pulse + inbox cap.
 *
 * Phase 4 of the autonomy retrofit. The Conductor (Phase 5) will provide a
 * real picker that ranks against pulse + ledger; Phase 4 ships
 * `staticQueuePicker` so the Director is callable end-to-end before Phase
 * 5 lands.
 *
 * Tick sequence per iteration:
 *   1. Budget check (phases run; minutes elapsed).
 *   2. Founder-inbox cap check (open rows in this workspace).
 *   3. Pulse-regression check (when `kill_on_pulse_regression`).
 *   4. Detect freshly answered inbox rows for this arc; flip them to
 *      `resolved` and surface to the picker so it can splice the answer
 *      into the next plan brief.
 *   5. Picker decides the next phase. `null` -> arc exits cleanly.
 *   6. Capture entry SHAs + write `director_phase_reports` row
 *      `status='in-flight'`.
 *   7. Run the phase orchestrator. Founder questions raised by the
 *      orchestrator land in `founder_inbox` via the injected hook.
 *   8. Capture exit SHAs + pulse delta + inbox-added count, then update
 *      the report row.
 *   9. Loop.
 *
 * The Director never reads round returns. The phase report is the
 * contract; everything else is forensic.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { runPhase } from './phase-orchestrator.js';
import type { PhaseInput, PhaseResult, PhaseStatus } from './phase-orchestrator.js';
import type { Mode, RoundExecutor } from './types.js';
import {
  answerFounderQuestion as _answerFounderQuestion,
  closeArc,
  countInboxAddedForPhase,
  listAnsweredFounderInbox,
  listOpenFounderInbox,
  listPhaseReportsForArc,
  openArc,
  resolveFounderQuestion,
  updatePhaseReport,
  writeFounderQuestion,
  writePhaseReport,
  type ArcExitReason,
  type ArcRecord,
  type FounderInboxOption,
  type FounderInboxRecord,
  type PhaseReportRecord,
  type PhaseReportStatus,
  type PulseSnapshot,
} from './director-persistence.js';

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

export interface PickerInput {
  arc: ArcRecord;
  prior_reports: PhaseReportRecord[];
  pulse: PulseSnapshot;
  /** Newly-answered founder questions detected this tick. The picker may
   * use these to splice answers into the next plan brief. */
  newly_answered: FounderInboxRecord[];
}

export interface PickerOutput {
  phase_id: string;
  mode: Mode;
  goal: string;
  initial_plan_brief: string;
  /**
   * Phase 6.7 (Deliverable B): inbox row ids the picker consumed when
   * building this pick (e.g. the cross-arc workspace-wide seed). The
   * Director resolves each id AFTER the phase report row transitions to
   * `status='in-flight'`. If the arc aborts (pulse-ko, runner threw,
   * budget cap) before the picker is called again, the unresolved rows
   * stay `answered` and the next tick's seed pre-fetch picks them up.
   * Optional; default is the empty list.
   */
  resolves_inbox_ids?: string[];
}

/**
 * Picker contract: returns the next phase to run, or `null` to signal
 * the Director that the arc should exit cleanly with `nothing-queued`.
 */
export type Picker = (input: PickerInput) => Promise<PickerOutput | null>;

export interface DirectorIO {
  readPulse: (workspace_id: string) => Promise<PulseSnapshot>;
  readRuntimeSha: () => Promise<string | null>;
  readCloudSha: () => Promise<string | null>;
  now: () => Date;
}

export interface ArcInput {
  workspace_id: string;
  thesis: string;
  mode_of_invocation: 'autonomous' | 'founder-initiated' | 'loop-tick';
  /** Optional explicit arc id; defaults to a deterministic-ish stamp. */
  arc_id?: string;
  budget_max_phases?: number;
  budget_max_minutes?: number;
  budget_max_inbox_qs?: number;
  kill_on_pulse_regression?: boolean;
  /** Defaults to `runPhase` (Phase 3 orchestrator). Tests inject a stub. */
  runPhase?: typeof runPhase;
}

export interface ArcResult {
  arc_id: string;
  status: 'closed' | 'aborted';
  exit_reason: ArcExitReason;
  phases_run: number;
  reports: PhaseReportRecord[];
}

const DEFAULT_BUDGET_MAX_PHASES = 6;
const DEFAULT_BUDGET_MAX_MINUTES = 240;
const DEFAULT_BUDGET_MAX_INBOX_QS = 3;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function genArcId(now: Date): string {
  const stamp = now.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `arc_${stamp}_${rand}`;
}

function genPhaseReportId(arcId: string, idx: number): string {
  return `${arcId}_pr${idx}`;
}

function phaseStatusToReportStatus(s: PhaseStatus): PhaseReportStatus {
  switch (s) {
    case 'phase-closed':
      return 'phase-closed';
    case 'phase-partial':
      return 'phase-partial';
    case 'phase-blocked-on-founder':
      return 'phase-blocked-on-founder';
    case 'phase-aborted':
      return 'phase-aborted';
  }
}

/**
 * Compare two pulse snapshots for regression. Returns a non-empty reason
 * string when current is materially worse than baseline; otherwise null.
 *
 * We intentionally only compare the two signals the spec calls out
 * (MRR, pipeline_count). Both must be present on both sides for the
 * check to fire — missing data is not a regression. Equality is OK;
 * only a strict drop counts.
 */
function detectPulseRegression(
  baseline: PulseSnapshot,
  current: PulseSnapshot,
): string | null {
  const reasons: string[] = [];
  if (
    typeof baseline.mrr_cents === 'number' &&
    typeof current.mrr_cents === 'number' &&
    current.mrr_cents < baseline.mrr_cents
  ) {
    reasons.push(`mrr_cents ${baseline.mrr_cents}->${current.mrr_cents}`);
  }
  if (
    typeof baseline.pipeline_count === 'number' &&
    typeof current.pipeline_count === 'number' &&
    current.pipeline_count < baseline.pipeline_count
  ) {
    reasons.push(
      `pipeline_count ${baseline.pipeline_count}->${current.pipeline_count}`,
    );
  }
  return reasons.length > 0 ? reasons.join('; ') : null;
}

function buildDeltaPulse(
  entry: PulseSnapshot,
  exit: PulseSnapshot,
): Record<string, unknown> {
  // Phase 4 records both endpoints; Phase 5 sharpens the diff into a
  // per-signal delta + trend label.
  return { entry, exit };
}

function genFounderQuestionId(now: Date): string {
  const stamp = now.toISOString().replace(/[^0-9]/g, '').slice(0, 17);
  const rand = Math.random().toString(36).slice(2, 6);
  return `fi_${stamp}_${rand}`;
}

// ----------------------------------------------------------------------------
// Default DirectorIO
// ----------------------------------------------------------------------------

export interface DefaultDirectorIOOptions {
  /** Path to the runtime repo root for `git rev-parse HEAD`. Defaults to process.cwd(). */
  repoRoot?: string;
  /** Path to the cloud repo. Defaults to `<repoRoot>/../ohwow.fun`. */
  cloudRepoRoot?: string;
  db: DatabaseAdapter;
}

interface BusinessVitalsRow {
  ts: string;
  mrr: number | null;
  active_users: number | null;
  daily_cost_cents: number | null;
}

function shortSha(sha: string): string {
  return sha.trim().slice(0, 7);
}

function readGitShaSafely(repoRoot: string): string | null {
  try {
    if (!existsSync(repoRoot)) return null;
    const out = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    if (!trimmed) return null;
    return shortSha(trimmed);
  } catch (err) {
    logger.warn(
      { repo_root: repoRoot, err: (err as Error).message },
      'director.git.sha.read.failed',
    );
    return null;
  }
}

export function defaultDirectorIO(
  opts: DefaultDirectorIOOptions,
): DirectorIO {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const cloudRepoRoot =
    opts.cloudRepoRoot ?? path.resolve(repoRoot, '..', 'ohwow.fun');
  const db = opts.db;

  return {
    now: () => new Date(),
    readRuntimeSha: async () => readGitShaSafely(repoRoot),
    readCloudSha: async () => readGitShaSafely(cloudRepoRoot),
    readPulse: async (workspace_id: string): Promise<PulseSnapshot> => {
      const ts = new Date().toISOString();
      try {
        const vitalsRes = await db
          .from<BusinessVitalsRow>('business_vitals')
          .select('ts, mrr, active_users, daily_cost_cents')
          .eq('workspace_id', workspace_id)
          .order('ts', { ascending: false })
          .limit(1);
        const vitals = (vitalsRes.data ?? [])[0];

        // Pipeline / failing-trigger / approval counts come from raw
        // queries on tables that may or may not exist on a fresh DB.
        // Phase 5 sharpens the pulse reader once we wire the conductor;
        // for now we read business_vitals only and leave the rest
        // undefined.

        const snap: PulseSnapshot = { ts };
        if (vitals?.mrr !== undefined && vitals?.mrr !== null) {
          snap.mrr_cents = vitals.mrr;
        }
        if (
          vitals?.active_users !== undefined &&
          vitals?.active_users !== null
        ) {
          snap.active_users = vitals.active_users;
        }
        if (
          vitals?.daily_cost_cents !== undefined &&
          vitals?.daily_cost_cents !== null
        ) {
          snap.daily_cost_cents = vitals.daily_cost_cents;
        }
        return snap;
      } catch (err) {
        logger.warn(
          { workspace_id, err: (err as Error).message },
          'director.pulse.read.failed',
        );
        return { ts };
      }
    },
  };
}

// ----------------------------------------------------------------------------
// Static-queue picker (test + Phase-5-replacement-target)
// ----------------------------------------------------------------------------

/**
 * Pops items in order, returning `null` when the queue is empty. The
 * Conductor (Phase 5) replaces this with a real ranker. Tests use it
 * to drive the Director through deterministic phase sequences.
 *
 * If `onAnswered` is supplied, the picker calls it for every newly
 * answered founder question on the tick; the function may mutate the
 * pending queue (e.g. inject a follow-up phase that splices the answer
 * into its plan brief).
 */
export function staticQueuePicker(
  items: PickerOutput[],
  hooks?: {
    onAnswered?: (
      answered: FounderInboxRecord[],
      remaining: PickerOutput[],
    ) => void;
  },
): Picker {
  const queue: PickerOutput[] = [...items];
  return async ({ newly_answered }) => {
    if (newly_answered.length > 0 && hooks?.onAnswered) {
      hooks.onAnswered(newly_answered, queue);
    }
    return queue.shift() ?? null;
  };
}

// ----------------------------------------------------------------------------
// Founder-inbox hook builder
// ----------------------------------------------------------------------------

export interface PendingFounderQuestion {
  blocker: string;
  context: string;
  options: FounderInboxOption[];
  recommended?: string;
  screenshot_path?: string;
}

/**
 * Build the `onFounderQuestion` hook the phase orchestrator will call
 * when a round returns `status='needs-input'`. Writes a row to
 * `founder_inbox` keyed to this arc + phase report.
 */
function makeFounderQuestionHook(
  db: DatabaseAdapter,
  io: DirectorIO,
  workspace_id: string,
  arc_id: string,
  phase_report_id: string,
  mode: Mode,
): NonNullable<PhaseInput['onFounderQuestion']> {
  return async ({ ret }) => {
    // The trio runner hands us `ret.summary` as the blocker. The plan
    // round's `next_round_brief` (when set) is the longer context.
    const summary = ret.summary || 'phase needs founder input';
    const context = ret.next_round_brief ?? '';
    const id = genFounderQuestionId(io.now());
    try {
      await writeFounderQuestion(db, {
        id,
        workspace_id,
        arc_id,
        phase_id: phase_report_id,
        mode,
        blocker: summary.split('\n')[0].slice(0, 240),
        context,
        options: [],
        recommended: null,
        screenshot_path: null,
        asked_at: io.now().toISOString(),
      });
    } catch (err) {
      logger.error(
        {
          arc_id,
          phase_report_id,
          err: (err as Error).message,
        },
        'director.founder_inbox.write.failed',
      );
    }
  };
}

// ----------------------------------------------------------------------------
// Main entry
// ----------------------------------------------------------------------------

export async function runArc(
  input: ArcInput,
  picker: Picker,
  executor: RoundExecutor,
  db: DatabaseAdapter,
  io: DirectorIO,
): Promise<ArcResult> {
  const phaseRunner = input.runPhase ?? runPhase;
  const budget_max_phases = input.budget_max_phases ?? DEFAULT_BUDGET_MAX_PHASES;
  const budget_max_minutes = input.budget_max_minutes ?? DEFAULT_BUDGET_MAX_MINUTES;
  const budget_max_inbox_qs = input.budget_max_inbox_qs ?? DEFAULT_BUDGET_MAX_INBOX_QS;
  const kill_on_pulse_regression = input.kill_on_pulse_regression ?? true;

  const openedAt = io.now();
  const arc_id = input.arc_id ?? genArcId(openedAt);
  const pulseAtEntry = await io.readPulse(input.workspace_id);

  await openArc(db, {
    id: arc_id,
    workspace_id: input.workspace_id,
    mode_of_invocation: input.mode_of_invocation,
    thesis: input.thesis,
    budget_max_phases,
    budget_max_minutes,
    budget_max_inbox_qs,
    kill_on_pulse_regression,
    pulse_at_entry: pulseAtEntry,
    opened_at: openedAt.toISOString(),
  });

  logger.info(
    {
      arc_id,
      workspace_id: input.workspace_id,
      thesis: input.thesis,
      mode_of_invocation: input.mode_of_invocation,
      budget_max_phases,
      budget_max_minutes,
      budget_max_inbox_qs,
    },
    'director.arc.open',
  );

  let phases_run = 0;
  let exit_reason: ArcExitReason = 'nothing-queued';
  const startedAtMs = openedAt.getTime();

  while (true) {
    // ---- 1. budget cap: phases ----
    if (phases_run >= budget_max_phases) {
      exit_reason = 'budget';
      break;
    }

    // ---- 1b. budget cap: minutes ----
    const elapsedMs = io.now().getTime() - startedAtMs;
    if (elapsedMs > budget_max_minutes * 60_000) {
      exit_reason = 'budget';
      break;
    }

    // ---- 2. inbox cap ----
    const openInbox = await listOpenFounderInbox(db, input.workspace_id);
    if (openInbox.length >= budget_max_inbox_qs) {
      exit_reason = 'founder-returned';
      break;
    }

    // ---- 3. pulse regression ----
    let currentPulse = await io.readPulse(input.workspace_id);
    if (kill_on_pulse_regression) {
      const reason = detectPulseRegression(pulseAtEntry, currentPulse);
      if (reason) {
        exit_reason = 'pulse-ko';
        logger.warn(
          { arc_id, reason },
          'director.arc.pulse_regression',
        );
        break;
      }
    }

    // ---- 4. detect answered inbox rows; resolve them ----
    const answered = await listAnsweredFounderInbox(db, arc_id);
    for (const row of answered) {
      try {
        await resolveFounderQuestion(db, row.id);
      } catch (err) {
        logger.error(
          { arc_id, inbox_id: row.id, err: (err as Error).message },
          'director.founder_inbox.resolve.failed',
        );
      }
    }

    // ---- 5. ask the picker for the next phase ----
    const prior_reports = await listPhaseReportsForArc(db, arc_id);
    const arcRow: ArcRecord = {
      id: arc_id,
      workspace_id: input.workspace_id,
      opened_at: openedAt.toISOString(),
      closed_at: null,
      mode_of_invocation: input.mode_of_invocation,
      thesis: input.thesis,
      status: 'open',
      budget_max_phases,
      budget_max_minutes,
      budget_max_inbox_qs,
      kill_on_pulse_regression,
      pulse_at_entry: pulseAtEntry,
      pulse_at_close: null,
      exit_reason: null,
    };
    const pick = await picker({
      arc: arcRow,
      prior_reports,
      pulse: currentPulse,
      newly_answered: answered,
    });
    if (!pick) {
      exit_reason = 'nothing-queued';
      break;
    }

    // ---- 6. capture entry SHAs + write phase report row ----
    const phaseStartedAt = io.now();
    const phaseStartIso = phaseStartedAt.toISOString();
    const phaseStartedMs = phaseStartedAt.getTime();
    const reportIdx = phases_run + 1;
    const phaseReportId = genPhaseReportId(arc_id, reportIdx);

    let runtime_sha_start: string | null = null;
    let cloud_sha_start: string | null = null;
    try {
      runtime_sha_start = await io.readRuntimeSha();
    } catch (err) {
      logger.warn(
        { arc_id, err: (err as Error).message },
        'director.sha.runtime.start.failed',
      );
    }
    try {
      cloud_sha_start = await io.readCloudSha();
    } catch (err) {
      logger.warn(
        { arc_id, err: (err as Error).message },
        'director.sha.cloud.start.failed',
      );
    }

    await writePhaseReport(db, {
      id: phaseReportId,
      arc_id,
      workspace_id: input.workspace_id,
      phase_id: pick.phase_id,
      mode: pick.mode,
      goal: pick.goal,
      status: 'in-flight',
      started_at: phaseStartIso,
    });

    // ---- 6b. (Phase 6.7 Deliverable B) resolve any inbox rows the
    // picker drained for this pick. We do this AFTER the phase report
    // row transitions to in-flight so the contract is: an inbox row
    // moves to `resolved` only when work is committed to actually
    // execute. If pulse-ko / budget tripped earlier we'd have already
    // exited the loop above; the unresolved row would survive for the
    // next tick.
    for (const inboxId of pick.resolves_inbox_ids ?? []) {
      try {
        await resolveFounderQuestion(db, inboxId);
      } catch (err) {
        logger.warn(
          {
            arc_id,
            inbox_id: inboxId,
            err: (err as Error).message,
          },
          'director.founder_inbox.post_inflight_resolve.failed',
        );
      }
    }

    // ---- 7. run the phase ----
    const phaseInput: PhaseInput = {
      phase_id: pick.phase_id,
      workspace_id: input.workspace_id,
      mode: pick.mode,
      goal: pick.goal,
      initial_plan_brief: pick.initial_plan_brief,
      onFounderQuestion: makeFounderQuestionHook(
        db,
        io,
        input.workspace_id,
        arc_id,
        phaseReportId,
        pick.mode,
      ),
    };

    let phaseResult: PhaseResult;
    try {
      phaseResult = await phaseRunner(phaseInput, executor, db);
    } catch (err) {
      logger.error(
        {
          arc_id,
          phase_id: pick.phase_id,
          err: (err as Error).message,
        },
        'director.phase.run.failed',
      );
      // Mark the report aborted, then end the arc as aborted via budget
      // path: there's no spec'd "phase-threw" exit reason. Treat as a
      // pulse-ko-equivalent abort.
      const phaseEndedAt = io.now();
      await updatePhaseReport(db, {
        id: phaseReportId,
        status: 'phase-aborted',
        trios_run: 0,
        runtime_sha_start,
        runtime_sha_end: runtime_sha_start,
        cloud_sha_start,
        cloud_sha_end: cloud_sha_start,
        delta_pulse_json: buildDeltaPulse(pulseAtEntry, currentPulse),
        delta_ledger: 'phase orchestrator threw',
        inbox_added: '0',
        remaining_scope: pick.goal,
        next_phase_recommendation: 'arc-stop',
        cost_trios: 0,
        cost_minutes: Math.max(
          0,
          Math.round((phaseEndedAt.getTime() - phaseStartedMs) / 60_000),
        ),
        cost_llm_cents: 0,
        raw_report: `phase-aborted: ${(err as Error).message}`,
        ended_at: phaseEndedAt.toISOString(),
      });
      exit_reason = 'pulse-ko';
      phases_run += 1;
      break;
    }

    // ---- 8. capture exit SHAs + delta + inbox-added; update report ----
    let runtime_sha_end: string | null = runtime_sha_start;
    let cloud_sha_end: string | null = cloud_sha_start;
    try {
      runtime_sha_end = await io.readRuntimeSha();
    } catch (err) {
      logger.warn(
        { arc_id, err: (err as Error).message },
        'director.sha.runtime.end.failed',
      );
    }
    try {
      cloud_sha_end = await io.readCloudSha();
    } catch (err) {
      logger.warn(
        { arc_id, err: (err as Error).message },
        'director.sha.cloud.end.failed',
      );
    }

    currentPulse = await io.readPulse(input.workspace_id);
    const phaseEndedAt = io.now();
    const inbox_added = await countInboxAddedForPhase(db, phaseReportId);
    const cost_minutes = Math.max(
      0,
      Math.round((phaseEndedAt.getTime() - phaseStartedMs) / 60_000),
    );

    await updatePhaseReport(db, {
      id: phaseReportId,
      status: phaseStatusToReportStatus(phaseResult.status),
      trios_run: phaseResult.trios.length,
      runtime_sha_start,
      runtime_sha_end,
      cloud_sha_start,
      cloud_sha_end,
      delta_pulse_json: buildDeltaPulse(pulseAtEntry, currentPulse),
      delta_ledger: `trios=${phaseResult.trios.length}`,
      inbox_added: String(inbox_added),
      remaining_scope:
        phaseResult.status === 'phase-closed' ? null : pick.goal,
      next_phase_recommendation: null,
      cost_trios: phaseResult.trios.length,
      cost_minutes,
      cost_llm_cents: 0,
      raw_report: phaseResult.report,
      ended_at: phaseEndedAt.toISOString(),
    });

    phases_run += 1;

    logger.info(
      {
        arc_id,
        phase_report_id: phaseReportId,
        phase_status: phaseResult.status,
        trios_run: phaseResult.trios.length,
        inbox_added,
      },
      'director.phase.complete',
    );

    // Phase returned phase-blocked-on-founder: fall through and let the
    // next iteration's inbox-cap check decide whether the arc continues
    // (a single open question may not yet hit the cap).
  }

  // ---- exit: capture pulse_at_close, write closeArc ----
  const pulseAtClose = await io.readPulse(input.workspace_id);
  const arcStatus: 'closed' | 'aborted' =
    exit_reason === 'pulse-ko' ? 'aborted' : 'closed';

  await closeArc(db, {
    id: arc_id,
    status: arcStatus,
    exit_reason,
    pulse_at_close: pulseAtClose,
    closed_at: io.now().toISOString(),
  });

  const reports = await listPhaseReportsForArc(db, arc_id);

  logger.info(
    {
      arc_id,
      status: arcStatus,
      exit_reason,
      phases_run,
    },
    'director.arc.close',
  );

  return {
    arc_id,
    status: arcStatus,
    exit_reason,
    phases_run,
    reports,
  };
}

// Re-exported so callers (MCP/HTTP) can answer questions without a
// second import surface.
export const answerFounderQuestion = _answerFounderQuestion;
