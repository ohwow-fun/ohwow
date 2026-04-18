/**
 * Evaluation harness (Phase 6 of the autonomy retrofit).
 *
 * Drives `conductorTick`-equivalent runs against an in-memory SQLite,
 * with a fake clock + deterministic id factory + stub executor, so each
 * scenario produces a byte-identical ASCII transcript on every run.
 * The transcript is diffed against a committed golden snapshot. Drift
 * = regression.
 *
 * The harness deliberately does NOT call `conductorTick` itself —
 * `conductorTick` builds its own ranker picker that genenerates
 * non-deterministic phase ids using `new Date()`. Instead the harness
 * mirrors the conductor's tick logic exactly (open-arc check, pulse +
 * ledger pre-read, ranker probe for thesis, picker built from ranker,
 * `runArc`) but threads our id factory through for arc + phase ids and
 * routes time through the injected `DirectorIO.now` and our `refTimeMs`
 * so cadence / novelty windows are deterministic.
 *
 * Real-LLM eval seam: `RunOptions.makeExecutor` lets a future phase
 * swap in a sub-orchestrator-backed executor without touching the
 * harness or any scenario.
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import { defaultMakeStubExecutor } from '../conductor.js';
import {
  closeArc,
  countInboxAddedForPhase,
  listAnsweredFounderInbox,
  listAnsweredUnresolvedFounderInbox,
  listOpenArcs,
  listOpenFounderInbox,
  listPhaseReportsForArc,
  openArc,
  resolveFounderQuestion,
  updatePhaseReport,
  writePhaseReport,
  type ArcExitReason,
  type FounderInboxRecord,
  type PhaseReportRecord,
  type PulseSnapshot,
} from '../director-persistence.js';
import { runPhase, type PhaseInput, type PhaseStatus } from '../phase-orchestrator.js';
import { readFullPulse, type FullPulseSnapshot } from '../pulse.js';
import {
  rankNextPhase,
  readLedgerSnapshot,
  type RankedPhase,
} from '../ranker.js';
import type { DirectorIO, PickerOutput } from '../director.js';
import type { ConductorTickResult } from '../conductor.js';
import type { RoundExecutor } from '../types.js';
import { applySeed, summarizeSeed } from './seed.js';
import { getMidArcHook } from './mid-arc-hook.js';
import type {
  RunAllResult,
  RunOptions,
  Scenario,
  ScenarioArcSummary,
  ScenarioContext,
  ScenarioFinals,
  ScenarioInboxChange,
  ScenarioPhaseSummary,
  ScenarioStep,
  ScenarioStepRecord,
  ScenarioTranscript,
} from './types.js';
import { logger } from '../../lib/logger.js';

// ----------------------------------------------------------------------------
// Paths
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const SCENARIOS_DIR = join(__dirname, 'scenarios');
const GOLDEN_DIR = join(__dirname, 'golden');

// ----------------------------------------------------------------------------
// Fake clock + id factory
// ----------------------------------------------------------------------------

interface FakeClock {
  now: () => Date;
  advance: (ms: number) => void;
  getMs: () => number;
}

function makeFakeClock(initialMs: number): FakeClock {
  let cur = initialMs;
  return {
    now: () => new Date(cur),
    advance: (ms: number) => {
      cur += ms;
    },
    getMs: () => cur,
  };
}

interface IdFactory {
  next: (prefix: string) => string;
  reset: () => void;
}

function makeIdFactory(): IdFactory {
  const counters = new Map<string, number>();
  return {
    next: (prefix: string) => {
      const cur = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, cur);
      return `${prefix}_${String(cur).padStart(3, '0')}`;
    },
    reset: () => counters.clear(),
  };
}

// ----------------------------------------------------------------------------
// In-memory DB bootstrap
// ----------------------------------------------------------------------------

function setupInMemoryDb(): {
  rawDb: InstanceType<typeof Database>;
  adapter: ReturnType<typeof createSqliteAdapter>;
} {
  const rawDb = new Database(':memory:');
  rawDb.pragma('foreign_keys = OFF');
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = sql.split(/^-- @statement$/m);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      try {
        rawDb.exec(trimmed);
      } catch {
        /* idempotent: re-runs and ALTER duplicates are expected */
      }
    }
  }
  const adapter = createSqliteAdapter(rawDb);
  return { rawDb, adapter };
}

// ----------------------------------------------------------------------------
// DirectorIO over the fake clock
// ----------------------------------------------------------------------------

function makeFakeDirectorIO(
  clock: FakeClock,
  pulseReader: () => Promise<FullPulseSnapshot>,
): DirectorIO {
  return {
    now: () => clock.now(),
    readRuntimeSha: async () => 'evalsha',
    readCloudSha: async () => null,
    // Director's runArc reads pulse via io.readPulse (PulseSnapshot
    // shape, narrower than FullPulseSnapshot). Lift the relevant
    // fields out so pulse-regression detection sees consistent
    // values.
    readPulse: async (): Promise<PulseSnapshot> => {
      const snap = await pulseReader();
      const out: PulseSnapshot = { ts: snap.ts };
      if (snap.mrr_cents !== undefined) out.mrr_cents = snap.mrr_cents;
      if (snap.pipeline_count !== undefined)
        out.pipeline_count = snap.pipeline_count;
      if (snap.failing_triggers.length > 0)
        out.failing_triggers = snap.failing_triggers.length;
      if (snap.pending_approvals_count !== undefined)
        out.pending_approvals = snap.pending_approvals_count;
      return out;
    },
  };
}

// ----------------------------------------------------------------------------
// Deterministic conductor tick — mirrors src/autonomy/conductor.ts
// ----------------------------------------------------------------------------

/**
 * Per-tick state held by the harness. Tracks the per-arc phase index so
 * `phaseIndex.get(arcId)` -> next phase id sequence number.
 */
interface HarnessTickState {
  workspace_id: string;
  db: ReturnType<typeof createSqliteAdapter>;
  io: DirectorIO;
  clock: FakeClock;
  ids: IdFactory;
  executor: RoundExecutor;
  /** Scenario name; used to look up an optional mid-arc mutation hook. */
  scenario_name: string;
}

// MIRROR OF conductor.ts:conductorTick + director.ts:runArc — keep in lockstep.
// Bug fixes that change conductor/director behavior MUST be reflected here
// (Phase 6.5 Bugs #1 and #2 are mirrored below: per-arc picked_keys dedupe
// and cross-arc workspace-wide answered seed).
async function runDeterministicTick(
  state: HarnessTickState,
): Promise<ConductorTickResult> {
  // 1. Open-arc check (mirrors conductor.ts).
  const open = await listOpenArcs(state.db, state.workspace_id);
  if (open.length > 0) {
    return { ran: false, reason: 'arc-in-flight' };
  }

  // 2. Probe pulse + ledger to build the thesis line.
  const pulse = await readFullPulse(state.db, state.workspace_id);
  const ledger = await readLedgerSnapshot(state.db, state.workspace_id);
  const refMs = state.clock.getMs();

  // Bug #2 (mirror): pre-fetch workspace-wide answered+unresolved inbox
  // rows so the first picker call resumes cross-arc answers.
  const seedAnswered = await listAnsweredUnresolvedFounderInbox(
    state.db,
    state.workspace_id,
  );

  const probe = rankNextPhase({
    pulse,
    ledger,
    newly_answered: seedAnswered,
    refTimeMs: refMs,
  });
  const thesis =
    probe.length > 0
      ? `autonomous: ${probe[0].goal}`
      : 'autonomous: scan for next-best phase';

  // 3. Build a deterministic picker. Mirrors conductor.ts but uses our
  //    id factory for phase ids and our clock for refTimeMs. Phase 6.5
  //    additions:
  //      - per-arc picked_keys dedupe (Bug #1)
  //      - one-shot seedAnswered drain merged into newly_answered, with
  //        seeded rows resolved so subsequent picker calls don't see
  //        them again (Bug #2)
  const picked_keys = new Set<string>();
  let seedAnsweredPending: FounderInboxRecord[] = seedAnswered;

  const picker = async ({
    newly_answered,
  }: {
    newly_answered: FounderInboxRecord[];
  }): Promise<PickerOutput | null> => {
    const curRefMs = state.clock.getMs();
    const fresh = await readFullPulse(state.db, state.workspace_id);
    const freshLedger = await readLedgerSnapshot(state.db, state.workspace_id);

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
      for (const row of seedAnsweredPending) {
        try {
          await state.db
            .from('founder_inbox')
            .update({ status: 'resolved' })
            .eq('id', row.id);
        } catch {
          /* swallow */
        }
      }
      seedAnsweredPending = [];
    }

    const ranked: RankedPhase[] = rankNextPhase({
      pulse: fresh,
      ledger: freshLedger,
      newly_answered: mergedAnswered,
      refTimeMs: curRefMs,
    });
    const filtered = ranked.filter(
      (c) => !picked_keys.has(`${c.mode}|${c.source}|${c.source_id ?? ''}`),
    );
    if (filtered.length === 0) return null;
    const top = filtered[0];
    picked_keys.add(`${top.mode}|${top.source}|${top.source_id ?? ''}`);
    return {
      phase_id: state.ids.next('phase'),
      mode: top.mode,
      goal: top.goal,
      initial_plan_brief: top.initial_plan_brief,
    };
  };

  // 4. Open arc with our deterministic id and run it via runArcDeterministic
  //    (a near-copy of director.runArc that uses `state.ids` for the
  //    phase report id and the founder question id).
  const arcId = state.ids.next('arc');
  const result = await runArcDeterministic({
    state,
    arc_id: arcId,
    thesis,
    picker,
  });

  return {
    ran: true,
    arc_id: result.arc_id,
    arc_status: result.status,
    exit_reason: result.exit_reason,
  };
}

interface RunArcDeterministicInput {
  state: HarnessTickState;
  arc_id: string;
  thesis: string;
  picker: (input: {
    newly_answered: FounderInboxRecord[];
  }) => Promise<PickerOutput | null>;
}

interface RunArcDeterministicResult {
  arc_id: string;
  status: 'closed' | 'aborted';
  exit_reason: ArcExitReason;
  phases_run: number;
  reports: PhaseReportRecord[];
}

/**
 * Mirror of director.runArc with two changes:
 *   - phase report ids come from `state.ids` (so transcripts are stable
 *     across runs);
 *   - founder question ids come from `state.ids` too, via a hook that
 *     overrides the default one (used by the orchestrator on
 *     status='needs-input' rounds).
 *
 * The control flow is intentionally identical to production. Any drift
 * between this mirror and director.runArc invalidates the eval — keep
 * them in lockstep.
 */
async function runArcDeterministic(
  input: RunArcDeterministicInput,
): Promise<RunArcDeterministicResult> {
  const { state } = input;
  const { db, io } = state;
  const budget_max_phases = 6;
  const budget_max_minutes = 240;
  const budget_max_inbox_qs = 3;
  const kill_on_pulse_regression = true;

  const openedAt = io.now();
  const pulseAtEntry = await io.readPulse(state.workspace_id);

  await openArc(db, {
    id: input.arc_id,
    workspace_id: state.workspace_id,
    mode_of_invocation: 'loop-tick',
    thesis: input.thesis,
    budget_max_phases,
    budget_max_minutes,
    budget_max_inbox_qs,
    kill_on_pulse_regression,
    pulse_at_entry: pulseAtEntry,
    opened_at: openedAt.toISOString(),
  });

  let phases_run = 0;
  let exit_reason: ArcExitReason = 'nothing-queued';
  const startedAtMs = openedAt.getTime();

  while (true) {
    if (phases_run >= budget_max_phases) {
      exit_reason = 'budget';
      break;
    }
    const elapsedMs = io.now().getTime() - startedAtMs;
    if (elapsedMs > budget_max_minutes * 60_000) {
      exit_reason = 'budget';
      break;
    }

    const openInbox = await listOpenFounderInbox(db, state.workspace_id);
    if (openInbox.length >= budget_max_inbox_qs) {
      exit_reason = 'founder-returned';
      break;
    }

    let currentPulse = await io.readPulse(state.workspace_id);
    if (kill_on_pulse_regression) {
      const regressionReason = detectPulseRegressionLocal(
        pulseAtEntry,
        currentPulse,
      );
      if (regressionReason) {
        exit_reason = 'pulse-ko';
        break;
      }
    }

    const answered = await listAnsweredFounderInbox(db, input.arc_id);
    for (const row of answered) {
      try {
        await resolveFounderQuestion(db, row.id);
      } catch {
        /* best-effort */
      }
    }

    const pick = await input.picker({ newly_answered: answered });
    if (!pick) {
      exit_reason = 'nothing-queued';
      break;
    }

    const phaseStartedAt = io.now();
    const phaseStartIso = phaseStartedAt.toISOString();
    const phaseStartedMs = phaseStartedAt.getTime();
    const phaseReportId = state.ids.next('pr');

    let runtime_sha_start: string | null = null;
    let cloud_sha_start: string | null = null;
    try {
      runtime_sha_start = await io.readRuntimeSha();
    } catch {
      /* swallow */
    }
    try {
      cloud_sha_start = await io.readCloudSha();
    } catch {
      /* swallow */
    }

    await writePhaseReport(db, {
      id: phaseReportId,
      arc_id: input.arc_id,
      workspace_id: state.workspace_id,
      phase_id: pick.phase_id,
      mode: pick.mode,
      goal: pick.goal,
      status: 'in-flight',
      started_at: phaseStartIso,
    });

    const onFounderQuestion: PhaseInput['onFounderQuestion'] = async ({
      ret,
    }) => {
      const summary = ret.summary || 'phase needs founder input';
      const context = ret.next_round_brief ?? '';
      const fiId = state.ids.next('fi');
      try {
        await db.from('founder_inbox').insert({
          id: fiId,
          workspace_id: state.workspace_id,
          arc_id: input.arc_id,
          phase_id: phaseReportId,
          mode: pick.mode,
          blocker: summary.split('\n')[0].slice(0, 240),
          context,
          options_json: '[]',
          recommended: null,
          screenshot_path: null,
          asked_at: io.now().toISOString(),
          status: 'open',
        });
      } catch {
        /* swallow */
      }
    };

    const phaseInput: PhaseInput = {
      phase_id: pick.phase_id,
      workspace_id: state.workspace_id,
      mode: pick.mode,
      goal: pick.goal,
      initial_plan_brief: pick.initial_plan_brief,
      onFounderQuestion,
    };

    let phaseStatus: PhaseStatus = 'phase-aborted';
    let triosRun = 0;
    let rawReport = '';
    try {
      const phaseResult = await runPhase(phaseInput, state.executor, db);
      phaseStatus = phaseResult.status;
      triosRun = phaseResult.trios.length;
      rawReport = phaseResult.report;
    } catch (err) {
      const phaseEndedAt = io.now();
      await updatePhaseReport(db, {
        id: phaseReportId,
        status: 'phase-aborted',
        trios_run: 0,
        runtime_sha_start,
        runtime_sha_end: runtime_sha_start,
        cloud_sha_start,
        cloud_sha_end: cloud_sha_start,
        delta_pulse_json: { entry: pulseAtEntry, exit: currentPulse },
        delta_ledger: 'phase orchestrator threw',
        inbox_added: '0',
        remaining_scope: pick.goal,
        next_phase_recommendation: 'arc-stop',
        cost_trios: 0,
        cost_minutes: 0,
        cost_llm_cents: 0,
        raw_report: `phase-aborted: ${(err as Error).message}`,
        ended_at: phaseEndedAt.toISOString(),
      });
      exit_reason = 'pulse-ko';
      phases_run += 1;
      break;
    }

    let runtime_sha_end: string | null = runtime_sha_start;
    let cloud_sha_end: string | null = cloud_sha_start;
    try {
      runtime_sha_end = await io.readRuntimeSha();
    } catch {
      /* swallow */
    }
    try {
      cloud_sha_end = await io.readCloudSha();
    } catch {
      /* swallow */
    }
    currentPulse = await io.readPulse(state.workspace_id);
    const phaseEndedAt = io.now();
    const inbox_added = await countInboxAddedForPhase(db, phaseReportId);
    const cost_minutes = Math.max(
      0,
      Math.round((phaseEndedAt.getTime() - phaseStartedMs) / 60_000),
    );

    await updatePhaseReport(db, {
      id: phaseReportId,
      status: phaseStatus,
      trios_run: triosRun,
      runtime_sha_start,
      runtime_sha_end,
      cloud_sha_start,
      cloud_sha_end,
      delta_pulse_json: { entry: pulseAtEntry, exit: currentPulse },
      delta_ledger: `trios=${triosRun}`,
      inbox_added: String(inbox_added),
      remaining_scope:
        phaseStatus === 'phase-closed' ? null : pick.goal,
      next_phase_recommendation: null,
      cost_trios: triosRun,
      cost_minutes,
      cost_llm_cents: 0,
      raw_report: rawReport,
      ended_at: phaseEndedAt.toISOString(),
    });

    phases_run += 1;

    // ---- mid-arc hook (eval-only): mutates DB between iterations so a
    // scenario can simulate a pulse drop, a new approval landing, etc.
    const hook = getMidArcHook(state.scenario_name);
    if (hook) {
      try {
        await hook(db, {
          workspace_id: state.workspace_id,
          now: () => io.now(),
        });
      } catch {
        /* hook failures don't crash the arc */
      }
    }
  }

  const pulseAtClose = await io.readPulse(state.workspace_id);
  const arcStatus: 'closed' | 'aborted' =
    exit_reason === 'pulse-ko' ? 'aborted' : 'closed';

  await closeArc(db, {
    id: input.arc_id,
    status: arcStatus,
    exit_reason,
    pulse_at_close: pulseAtClose,
    closed_at: io.now().toISOString(),
  });

  const reports = await listPhaseReportsForArc(db, input.arc_id);

  return {
    arc_id: input.arc_id,
    status: arcStatus,
    exit_reason,
    phases_run,
    reports,
  };
}

/** Local mirror of director-private `detectPulseRegression`. */
function detectPulseRegressionLocal(
  baseline: PulseSnapshot,
  current: PulseSnapshot,
): string | null {
  if (
    typeof baseline.mrr_cents === 'number' &&
    typeof current.mrr_cents === 'number' &&
    current.mrr_cents < baseline.mrr_cents
  ) {
    return `mrr_cents ${baseline.mrr_cents}->${current.mrr_cents}`;
  }
  if (
    typeof baseline.pipeline_count === 'number' &&
    typeof current.pipeline_count === 'number' &&
    current.pipeline_count < baseline.pipeline_count
  ) {
    return `pipeline_count ${baseline.pipeline_count}->${current.pipeline_count}`;
  }
  return null;
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

const FIXED_EPOCH_MS = Date.UTC(2026, 3, 18, 12, 0, 0); // 2026-04-18T12:00:00Z

export async function runScenario(
  scenario: Scenario,
  opts: RunOptions = {},
): Promise<ScenarioTranscript> {
  const silent = opts.silent ?? true;
  const prevLogLevel = logger.level;
  if (silent) logger.level = 'silent';

  const prevFlag = process.env.OHWOW_AUTONOMY_CONDUCTOR;
  process.env.OHWOW_AUTONOMY_CONDUCTOR = '1';
  const { rawDb, adapter } = setupInMemoryDb();
  const clock = makeFakeClock(FIXED_EPOCH_MS);
  const ids = makeIdFactory();
  const workspace_id = 'ws-eval';
  const ctx: ScenarioContext = {
    workspace_id,
    now: clock.now,
    advance: clock.advance,
    nextId: ids.next,
    db: adapter,
  };

  const transcript: ScenarioTranscript = {
    scenario: scenario.name,
    describe: scenario.describe,
    initial_seed_summary: summarizeSeed(scenario.initial_seed),
    steps: [],
    finals: {
      open_arcs: 0,
      closed_arcs: 0,
      aborted_arcs: 0,
      total_phase_reports: 0,
      open_founder_inbox: 0,
    },
  };

  try {
    await applySeed(ctx, scenario.initial_seed);

    const makeExecutor =
      opts.makeExecutor ?? scenario.makeExecutor ?? defaultMakeStubExecutor;
    const tickState: HarnessTickState = {
      workspace_id,
      db: adapter,
      io: makeFakeDirectorIO(clock, () =>
        readFullPulse(adapter, workspace_id),
      ),
      clock,
      ids,
      executor: makeExecutor(),
      scenario_name: scenario.name,
    };

    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const record = await applyStep(ctx, tickState, step, i, adapter, workspace_id);
      transcript.steps.push(record);
    }

    transcript.finals = await readFinals(adapter, workspace_id);
  } finally {
    rawDb.close();
    if (prevFlag === undefined) {
      delete process.env.OHWOW_AUTONOMY_CONDUCTOR;
    } else {
      process.env.OHWOW_AUTONOMY_CONDUCTOR = prevFlag;
    }
    if (silent) logger.level = prevLogLevel;
  }

  return transcript;
}

async function applyStep(
  ctx: ScenarioContext,
  tickState: HarnessTickState,
  step: ScenarioStep,
  step_index: number,
  adapter: ReturnType<typeof createSqliteAdapter>,
  workspace_id: string,
): Promise<ScenarioStepRecord> {
  const base: ScenarioStepRecord = {
    step_index,
    kind: step.kind,
    note: step.note,
  };

  switch (step.kind) {
    case 'tick': {
      const before = await readInboxIds(adapter, workspace_id);
      const result = await runDeterministicTick(tickState);
      base.tick_result = result;
      if (result.arc_id) {
        base.arc_summary = await summariseArc(adapter, result.arc_id);
      }
      const after = await readInboxIds(adapter, workspace_id);
      base.inbox_changes = diffInbox(before, after);
      return base;
    }
    case 'advance': {
      ctx.advance(step.ms ?? 0);
      return base;
    }
    case 'seed': {
      if (step.spec) await applySeed(ctx, step.spec);
      return base;
    }
    case 'answer-founder': {
      if (!step.founder_inbox_id) {
        throw new Error('answer-founder step requires founder_inbox_id');
      }
      await adapter
        .from('founder_inbox')
        .update({
          status: 'answered',
          answer: step.founder_answer ?? 'eval answer',
          answered_at: ctx.now().toISOString(),
        })
        .eq('id', step.founder_inbox_id);
      return base;
    }
  }
}

async function readInboxIds(
  db: ReturnType<typeof createSqliteAdapter>,
  workspace_id: string,
): Promise<Map<string, string>> {
  const { data } = await db
    .from<{ id: string; status: string }>('founder_inbox')
    .select('id, status')
    .eq('workspace_id', workspace_id);
  const out = new Map<string, string>();
  for (const r of data ?? []) out.set(r.id, r.status);
  return out;
}

function diffInbox(
  before: Map<string, string>,
  after: Map<string, string>,
): ScenarioInboxChange[] {
  const out: ScenarioInboxChange[] = [];
  for (const [id, status] of after.entries()) {
    if (before.get(id) !== status) {
      out.push({ id, status });
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

async function summariseArc(
  db: ReturnType<typeof createSqliteAdapter>,
  arc_id: string,
): Promise<ScenarioArcSummary | undefined> {
  const arc = (
    await db
      .from<{ id: string; status: string; exit_reason: string | null }>(
        'director_arcs',
      )
      .select('id, status, exit_reason')
      .eq('id', arc_id)
      .maybeSingle()
  ).data;
  if (!arc) return undefined;
  const reports = await listPhaseReportsForArc(db, arc_id);
  // Sort by id explicitly: when many phases land in the same fake-clock
  // millisecond, SQL has no stable secondary order. The id factory
  // generates monotonically increasing ids so sorting by id matches
  // chronological order while staying deterministic.
  reports.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const phases: ScenarioPhaseSummary[] = reports.map((r) => ({
    phase_id: r.phase_id,
    mode: r.mode,
    status: r.status,
    trios: r.trios_run,
    goal: r.goal,
  }));
  return {
    arc_id: arc.id,
    status: arc.status,
    exit_reason: arc.exit_reason ?? '',
    phases,
  };
}

async function readFinals(
  db: ReturnType<typeof createSqliteAdapter>,
  workspace_id: string,
): Promise<ScenarioFinals> {
  const arcsRes = await db
    .from<{ id: string; status: string }>('director_arcs')
    .select('id, status')
    .eq('workspace_id', workspace_id);
  const arcs = arcsRes.data ?? [];
  const open_arcs = arcs.filter((a) => a.status === 'open').length;
  const closed_arcs = arcs.filter((a) => a.status === 'closed').length;
  const aborted_arcs = arcs.filter((a) => a.status === 'aborted').length;

  const reportsRes = await db
    .from<{ id: string }>('director_phase_reports')
    .select('id')
    .eq('workspace_id', workspace_id);
  const total_phase_reports = (reportsRes.data ?? []).length;

  const open_founder_inbox = (
    await listOpenFounderInbox(db, workspace_id)
  ).length;

  return {
    open_arcs,
    closed_arcs,
    aborted_arcs,
    total_phase_reports,
    open_founder_inbox,
  };
}

// ----------------------------------------------------------------------------
// Transcript formatting
// ----------------------------------------------------------------------------

export function formatTranscript(t: ScenarioTranscript): string {
  const lines: string[] = [];
  lines.push(`SCENARIO: ${t.scenario}`);
  lines.push(`DESCRIBE: ${t.describe}`);
  lines.push(`INITIAL_SEED: ${t.initial_seed_summary}`);
  for (const s of t.steps) {
    const noteSuffix = s.note ? ` // ${s.note}` : '';
    lines.push(`STEP ${s.step_index} [${s.kind}]${noteSuffix}`);
    if (s.kind === 'tick' && s.tick_result) {
      const r = s.tick_result;
      const parts: string[] = [`ran=${r.ran}`];
      if (r.arc_id) parts.push(`arc=${r.arc_id}`);
      if (r.arc_status) parts.push(`status=${r.arc_status}`);
      if (r.exit_reason) parts.push(`exit=${r.exit_reason}`);
      if (r.reason) parts.push(`reason=${r.reason}`);
      lines.push(`  result: ${parts.join(' ')}`);
      if (s.arc_summary) {
        const a = s.arc_summary;
        if (a.phases.length === 0) {
          lines.push(`  arc ${a.arc_id}: (no phases)`);
        } else {
          lines.push(`  arc ${a.arc_id}:`);
          for (const p of a.phases) {
            lines.push(
              `    ${p.phase_id} mode=${p.mode} status=${p.status} trios=${p.trios} goal="${p.goal}"`,
            );
          }
        }
      }
      if (s.inbox_changes && s.inbox_changes.length > 0) {
        const txt = s.inbox_changes
          .map((c) => `${c.id}->${c.status}`)
          .join(', ');
        lines.push(`  inbox: ${txt}`);
      }
    }
  }
  const f = t.finals;
  lines.push(
    `FINALS: arcs(open=${f.open_arcs} closed=${f.closed_arcs} aborted=${f.aborted_arcs}) phase_reports=${f.total_phase_reports} open_inbox=${f.open_founder_inbox}`,
  );
  return lines.join('\n') + '\n';
}

// ----------------------------------------------------------------------------
// Diff helper (unified, three-context-line)
// ----------------------------------------------------------------------------

function unifiedDiff(expected: string, actual: string): string {
  const exp = expected.split('\n');
  const act = actual.split('\n');
  const out: string[] = [];
  const max = Math.max(exp.length, act.length);
  for (let i = 0; i < max; i++) {
    const e = exp[i];
    const a = act[i];
    if (e === a) continue;
    if (e !== undefined) out.push(`-${e}`);
    if (a !== undefined) out.push(`+${a}`);
  }
  return out.join('\n');
}

// ----------------------------------------------------------------------------
// Scenario discovery + run-all
// ----------------------------------------------------------------------------

interface DiscoveredScenario {
  name: string;
  scenario: Scenario;
}

async function discoverScenarios(): Promise<DiscoveredScenario[]> {
  const files = readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort();
  const out: DiscoveredScenario[] = [];
  for (const f of files) {
    const mod = (await import(join(SCENARIOS_DIR, f))) as {
      default?: Scenario;
    };
    if (!mod.default) {
      throw new Error(`scenario file ${f} has no default export`);
    }
    out.push({ name: mod.default.name, scenario: mod.default });
  }
  return out;
}

export interface RunAllOptions extends RunOptions {
  /** Write golden files instead of diffing. */
  update?: boolean;
}

export async function runAllScenarios(
  opts: RunAllOptions = {},
): Promise<RunAllResult> {
  const startedMs = Date.now();
  const update = opts.update ?? process.env.OHWOW_AUTONOMY_EVAL_UPDATE === '1';
  const scenarios = await discoverScenarios();

  const pass: string[] = [];
  const fail: RunAllResult['fail'] = [];
  const updated: string[] = [];

  if (update && !existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

  for (const { scenario } of scenarios) {
    let transcript: ScenarioTranscript;
    try {
      transcript = await runScenario(scenario, opts);
    } catch (err) {
      fail.push({
        name: scenario.name,
        reason: `runScenario threw: ${(err as Error).message}`,
      });
      continue;
    }
    const formatted = formatTranscript(transcript);
    const goldenPath = join(GOLDEN_DIR, `${scenario.name}.txt`);

    if (update) {
      writeFileSync(goldenPath, formatted, 'utf8');
      updated.push(scenario.name);
      // Run assertions on update too — bad assertions should fail loudly.
      const assertionFail = await runAssertions(scenario, transcript);
      if (assertionFail) {
        fail.push({ name: scenario.name, reason: assertionFail });
        continue;
      }
      pass.push(scenario.name);
      continue;
    }

    if (!existsSync(goldenPath)) {
      fail.push({
        name: scenario.name,
        reason: `no golden at ${goldenPath} (run with --update to create)`,
        diff: formatted,
      });
      continue;
    }
    const expected = readFileSync(goldenPath, 'utf8');
    if (expected !== formatted) {
      fail.push({
        name: scenario.name,
        reason: 'transcript drift',
        diff: unifiedDiff(expected, formatted),
      });
      continue;
    }
    const assertionFail = await runAssertions(scenario, transcript);
    if (assertionFail) {
      fail.push({ name: scenario.name, reason: assertionFail });
      continue;
    }
    pass.push(scenario.name);
  }

  return {
    pass,
    fail,
    updated: update ? updated : undefined,
    duration_ms: Date.now() - startedMs,
  };
}

async function runAssertions(
  scenario: Scenario,
  transcript: ScenarioTranscript,
): Promise<string | null> {
  // The structural assertions need a fresh DB to read against — re-run
  // the scenario once more and pass that adapter into the assertions.
  // This is cheap (in-memory) and keeps the assertions independent of
  // any per-run mutable state.
  const { rawDb, adapter } = setupInMemoryDb();
  const clock = makeFakeClock(FIXED_EPOCH_MS);
  const ids = makeIdFactory();
  const workspace_id = 'ws-eval';
  const ctx: ScenarioContext = {
    workspace_id,
    now: clock.now,
    advance: clock.advance,
    nextId: ids.next,
    db: adapter,
  };
  const prevFlag = process.env.OHWOW_AUTONOMY_CONDUCTOR;
  process.env.OHWOW_AUTONOMY_CONDUCTOR = '1';
  const prevLogLevel = logger.level;
  logger.level = 'silent';
  try {
    await applySeed(ctx, scenario.initial_seed);
    const makeExecutor = scenario.makeExecutor ?? defaultMakeStubExecutor;
    const tickState: HarnessTickState = {
      workspace_id,
      db: adapter,
      io: makeFakeDirectorIO(clock, () => readFullPulse(adapter, workspace_id)),
      clock,
      ids,
      executor: makeExecutor(),
      scenario_name: scenario.name,
    };
    for (let i = 0; i < scenario.steps.length; i++) {
      await applyStep(
        ctx,
        tickState,
        scenario.steps[i],
        i,
        adapter,
        workspace_id,
      );
    }
    for (const fn of scenario.assertions) {
      try {
        await fn(transcript, { db: adapter, workspace_id });
      } catch (err) {
        return `assertion failed: ${(err as Error).message}`;
      }
    }
    return null;
  } finally {
    rawDb.close();
    if (prevFlag === undefined) {
      delete process.env.OHWOW_AUTONOMY_CONDUCTOR;
    } else {
      process.env.OHWOW_AUTONOMY_CONDUCTOR = prevFlag;
    }
    logger.level = prevLogLevel;
  }
}
