/**
 * Evaluation harness (Phase 6 of the autonomy retrofit).
 *
 * Drives production `conductorTick` against an in-memory SQLite, with a
 * fake clock + deterministic id factory + stub executor, so each scenario
 * produces a byte-identical ASCII transcript on every run. The transcript
 * is diffed against a committed golden snapshot. Drift = regression.
 *
 * Determinism is achieved by threading the harness's fake clock and id
 * factory into `ConductorDeps` via the `nowOverride`, `idFactory`, and
 * `runPhaseOverride` injectors added in Phase 6.10. The conductor and
 * director use these when present; production leaves them undefined.
 *
 * The `runPhaseOverride` wraps the production `runPhase` with the
 * scenario's optional mid-arc mutation hook (`getMidArcHook`), which
 * lets scenarios inject pulse drops or other DB mutations between phase
 * iterations without touching the production conductor.
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
import { conductorTick, defaultMakeStubExecutor, reconstructPickedKeys } from '../conductor.js';
import {
  listAnsweredUnresolvedFounderInbox,
  listOpenFounderInbox,
  listPhaseReportsForArc,
  type PhaseReportRecord,
  type PulseSnapshot,
} from '../director-persistence.js';
import { runPhase } from '../phase-orchestrator.js';
import { readFullPulse, type FullPulseSnapshot } from '../pulse.js';
import {
  rankNextPhase,
  readLedgerSnapshot,
  type RankedPhase,
} from '../ranker.js';
import type { DirectorIO } from '../director.js';
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
  ScenarioRestartPick,
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
// Per-tick harness state
// ----------------------------------------------------------------------------

/**
 * Per-tick state held by the harness. Tracks the fake clock + id factory so
 * each `conductorTick` call gets deterministic timestamps and ids.
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

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

const FIXED_EPOCH_MS = Date.UTC(2026, 3, 18, 12, 0, 0); // 2026-04-18T12:00:00Z

export async function runScenario(
  scenario: Scenario,
  opts: RunOptions = {},
): Promise<ScenarioTranscript> {
  const held = await runScenarioKeepOpen(scenario, opts);
  held.close();
  return held.transcript;
}

export interface RunScenarioKeepOpenResult {
  transcript: ScenarioTranscript;
  db: ReturnType<typeof createSqliteAdapter>;
  workspace_id: string;
  /** Closes the underlying raw DB + restores env. Call when done asserting. */
  close: () => void;
}

/**
 * Same as `runScenario` but keeps the in-memory DB open after the run
 * so callers (Phase 6.9 real-LLM scenarios) can assert against live
 * rows — especially `director_phase_reports.cost_llm_cents` after the
 * meter has been plumbed through. The caller MUST invoke `close()`.
 */
export async function runScenarioKeepOpen(
  scenario: Scenario,
  opts: RunOptions = {},
): Promise<RunScenarioKeepOpenResult> {
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

  let threw = false;
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
  } catch (err) {
    threw = true;
    // Make sure we still clean up the DB + env when the run throws; the
    // caller would otherwise never see `close()` called.
    try {
      rawDb.close();
    } catch {
      /* already closed */
    }
    if (prevFlag === undefined) {
      delete process.env.OHWOW_AUTONOMY_CONDUCTOR;
    } else {
      process.env.OHWOW_AUTONOMY_CONDUCTOR = prevFlag;
    }
    if (silent) logger.level = prevLogLevel;
    throw err;
  }

  // Normal exit: caller owns the DB. Restore the silence flag now; the
  // env flag + rawDb live until `close()` is invoked.
  if (silent) logger.level = prevLogLevel;
  void threw;

  return {
    transcript,
    db: adapter,
    workspace_id,
    close: () => {
      try {
        rawDb.close();
      } catch {
        /* already closed */
      }
      if (prevFlag === undefined) {
        delete process.env.OHWOW_AUTONOMY_CONDUCTOR;
      } else {
        process.env.OHWOW_AUTONOMY_CONDUCTOR = prevFlag;
      }
    },
  };
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
      // Wrap runPhase with the mid-arc hook (eval-only seam) so scenarios can
      // mutate DB state between phase iterations (e.g. inject a pulse drop).
      const _hook = getMidArcHook(tickState.scenario_name);
      const _wrappedRunPhase: typeof runPhase = _hook
        ? async (phaseInput, executor, db) => {
            const r = await runPhase(phaseInput, executor, db);
            try {
              await _hook(db, {
                workspace_id: tickState.workspace_id,
                now: () => tickState.clock.now(),
              });
            } catch {
              /* hook failures don't crash the arc */
            }
            return r;
          }
        : runPhase;
      const result = await conductorTick({
        db: tickState.db,
        io: tickState.io,
        workspace_id: tickState.workspace_id,
        makeExecutor: () => tickState.executor,
        idFactory: (prefix) => tickState.ids.next(prefix),
        nowOverride: tickState.clock.now,
        refTimeMs: tickState.clock.getMs(),
        runPhaseOverride: _wrappedRunPhase,
      });
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
    case 'restart-pick-once': {
      // Phase 6.7 (Deliverable A): simulate "daemon crashed mid-arc and
      // restarted" by building a fresh picker against an existing OPEN
      // arc, calling reconstructPickedKeys to rebuild the dedupe set
      // from persisted phase_ids, and invoking the picker once. We
      // record what the picker would have picked (or null) without
      // actually running a phase. The arc itself stays in whatever
      // state it was in.
      if (!step.restart_arc_id) {
        throw new Error('restart-pick-once step requires restart_arc_id');
      }
      const arcId = step.restart_arc_id;
      const arcRow = (
        await adapter
          .from<{
            id: string;
            workspace_id: string;
            opened_at: string;
            mode_of_invocation: string;
            thesis: string;
            status: string;
            budget_max_phases: number;
            budget_max_minutes: number;
            budget_max_inbox_qs: number;
            kill_on_pulse_regression: number;
            pulse_at_entry_json: string;
          }>('director_arcs')
          .select()
          .eq('id', arcId)
          .maybeSingle()
      ).data;
      if (!arcRow) {
        base.restart_pick = {
          picked: false,
          reason: `arc ${arcId} not found`,
        };
        return base;
      }

      // Rebuild picked_keys from this arc's persisted phase_ids.
      const restored = await reconstructPickedKeys(adapter, arcId);

      // Build a single-shot picker mirror of the production picker but
      // pre-seeded with `restored`. We don't reuse the conductor's
      // picker factory because it pulls from the live ranker every time;
      // here we want a single-call shape.
      const fresh = await readFullPulse(adapter, workspace_id);
      const freshLedger = await readLedgerSnapshot(adapter, workspace_id);
      const seedAnswered = await listAnsweredUnresolvedFounderInbox(
        adapter,
        workspace_id,
      );
      const ranked: RankedPhase[] = rankNextPhase({
        pulse: fresh,
        ledger: freshLedger,
        newly_answered: seedAnswered,
        refTimeMs: tickState.clock.getMs(),
      });
      const filtered = ranked.filter(
        (c) => !restored.has(`${c.mode}|${c.source}|${c.source_id ?? ''}`),
      );
      if (filtered.length === 0) {
        base.restart_pick = {
          picked: false,
          reason: 'all candidates already picked in this arc',
        };
        return base;
      }
      const top = filtered[0];
      base.restart_pick = {
        picked: true,
        phase_id: tickState.ids.next('restartphase'),
        mode: top.mode,
        goal: top.goal,
      };
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
    if (s.kind === 'restart-pick-once' && s.restart_pick) {
      const p = s.restart_pick;
      if (p.picked) {
        lines.push(
          `  restart_pick: picked mode=${p.mode} goal="${p.goal ?? ''}"`,
        );
      } else {
        lines.push(`  restart_pick: none reason="${p.reason ?? ''}"`);
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
  /**
   * Phase 6.9: when true, also discover and run the real-LLM scenarios
   * under `src/autonomy/eval/scenarios-llm/`. Requires
   * `OHWOW_AUTONOMY_EVAL_REAL=1` in the environment; otherwise the LLM
   * suite is skipped even if this flag is set. Deterministic scenarios
   * always run (unless `skip_deterministic` is true).
   */
  real?: boolean;
  /** Skip the deterministic scenario suite (pairs with `real=true`). */
  skip_deterministic?: boolean;
  /** Passed through to the LLM suite. Default 10c. */
  llm_spend_cap_cents?: number;
  /** Passed through to the LLM suite. Default 'claude-haiku-4-5-20251001'. */
  llm_model?: string;
}

export async function runAllScenarios(
  opts: RunAllOptions = {},
): Promise<RunAllResult> {
  const startedMs = Date.now();
  const update = opts.update ?? process.env.OHWOW_AUTONOMY_EVAL_UPDATE === '1';
  const runDeterministic = !opts.skip_deterministic;
  const scenarios = runDeterministic ? await discoverScenarios() : [];

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

  // Phase 6.9 — optionally append the real-LLM suite. The LLM runner
  // prints its own per-scenario cost lines; here we fold its
  // pass/fail into the combined result so callers can still branch on
  // `result.fail.length`.
  if (opts.real) {
    const { isRealLlmEvalEnabled, runAllLlmScenarios } = await import(
      './harness-llm.js'
    );
    if (!isRealLlmEvalEnabled()) {
      fail.push({
        name: 'real-llm-suite',
        reason:
          '--real requested but OHWOW_AUTONOMY_EVAL_REAL=1 is not set; refusing to run real LLM calls.',
      });
    } else {
      const llm = await runAllLlmScenarios({
        model: opts.llm_model,
        spendCapCents: opts.llm_spend_cap_cents,
      });
      for (const name of llm.pass) pass.push(name);
      for (const f of llm.fail) fail.push({ name: f.name, reason: f.reason });
    }
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
