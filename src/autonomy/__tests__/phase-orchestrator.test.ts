/**
 * Phase orchestrator tests (Phase 3 of the autonomy retrofit).
 *
 * Covers:
 *   1. Happy path (1 trio, all-pass)
 *   2. Regression then successful retry — re-plan brief carries qa fail
 *   3. Two regressions with max_trios=2 -> phase-partial
 *   4. Regression with on_regression='close-partial' -> only 1 trio
 *   5. plan needs-input -> phase-blocked-on-founder, no further trio
 *   6. Phase-level abort between trios after a regression
 *   7. Persistence round-trip via loadTrio
 *   8. Report shape (5 lines, ASCII, goal preserved)
 *   9. Wall clock max_minutes=0 trips after first trio
 *  10. Concurrent runPhase calls against the same DB
 *
 * Uses an in-memory SQLite DB with the migration runner picking up all
 * sql files through 143-phase-trios.sql.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import { runPhase } from '../phase-orchestrator.js';
import type { PhaseInput } from '../phase-orchestrator.js';
import { loadTrio } from '../persistence.js';
import {
  StubExecutor,
  TrioScriptedExecutor,
  planContinue,
  implContinue,
  qaPassed,
  qaFailedEscalate,
} from './_stubs.js';
import type {
  AbortSignalSource,
  RoundBrief,
  RoundExecutor,
  RoundReturn,
} from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

function setupDb(): { rawDb: InstanceType<typeof Database>; adapter: ReturnType<typeof createSqliteAdapter> } {
  const rawDb = new Database(':memory:');
  rawDb.pragma('foreign_keys = OFF'); // 143 has no FKs; keep OFF for parity with init.ts's first-pass

  // Apply every migration up through 143-phase-trios.sql in name order.
  // We can't import init.ts directly because it pulls in the full
  // workspace-aware boot path. Mirror only the file-walk piece here.
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
        // Mirror init.ts: idempotent ALTERs / pre-existing tables are tolerated.
      }
    }
  }

  const adapter = createSqliteAdapter(rawDb);
  return { rawDb, adapter };
}

function basePhaseInput(over: Partial<PhaseInput> = {}): PhaseInput {
  return {
    phase_id: 'p_test_001',
    workspace_id: 'ws-test',
    mode: 'plumbing',
    goal: 'unstick the failing-trigger sweep',
    initial_plan_brief: 'plan brief body',
    ...over,
  };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('runPhase — happy path', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => {
    ({ rawDb, adapter } = setupDb());
  });
  afterEach(() => {
    rawDb.close();
  });

  it('1 trio all-pass -> phase-closed; 1 trio + 3 rounds in DB', async () => {
    const exec = new StubExecutor({
      plan: [planContinue],
      impl: [implContinue],
      qa: [qaPassed],
    });

    const result = await runPhase(basePhaseInput(), exec, adapter);

    expect(result.status).toBe('phase-closed');
    expect(result.trios).toHaveLength(1);
    expect(result.trios[0].outcome).toBe('successful');

    const trioRows = rawDb.prepare('SELECT * FROM phase_trios').all() as Array<{
      id: string;
      outcome: string;
      ended_at: string | null;
    }>;
    expect(trioRows).toHaveLength(1);
    expect(trioRows[0].id).toBe('p_test_001-t1');
    expect(trioRows[0].outcome).toBe('successful');
    expect(trioRows[0].ended_at).not.toBeNull();

    const roundRows = rawDb.prepare('SELECT * FROM phase_rounds ORDER BY id').all() as Array<{
      id: string;
      kind: string;
    }>;
    expect(roundRows).toHaveLength(3);
    expect(roundRows.map((r) => r.kind)).toEqual(['plan', 'impl', 'qa']);

    expect(result.report).toContain('STATUS: phase-closed');
    expect(result.report).toContain('NEXT: arc-stop');
  });
});

describe('runPhase — regression then successful retry', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => {
    ({ rawDb, adapter } = setupDb());
  });
  afterEach(() => {
    rawDb.close();
  });

  it('trio 1 regressed, trio 2 successful -> phase-closed; 2 trios + 6 rounds; brief carries qa-fail reason', async () => {
    const phase = basePhaseInput({ phase_id: 'p_retry_001' });
    const exec = new TrioScriptedExecutor(
      [
        // Trio 1: regression via failed-escalate
        { plan: [planContinue], impl: [implContinue], qa: [qaFailedEscalate] },
        // Trio 2: success
        { plan: [planContinue], impl: [implContinue], qa: [qaPassed] },
      ],
      (i) => `${phase.phase_id}-t${i + 1}`,
    );

    const result = await runPhase(phase, exec, adapter);

    expect(result.status).toBe('phase-closed');
    expect(result.trios).toHaveLength(2);
    expect(result.trios[0].outcome).toBe('regressed');
    expect(result.trios[1].outcome).toBe('successful');

    // Trio 2's plan brief must contain trio 1's qa-fail reason.
    const trio2PlanCall = exec.calls.find(
      (c) => c.trio_id === `${phase.phase_id}-t2` && c.kind === 'plan',
    );
    expect(trio2PlanCall).toBeDefined();
    // Reason from qaFailedEscalate is 'failed-escalate'; failed criteria
    // include 'idempotency check'. Either marker is sufficient evidence.
    expect(trio2PlanCall!.body).toMatch(/regressed/);
    expect(trio2PlanCall!.body).toMatch(/idempotency check|failed-escalate/);

    const trios = rawDb.prepare('SELECT id, outcome FROM phase_trios ORDER BY id').all() as Array<{
      id: string;
      outcome: string;
    }>;
    expect(trios).toHaveLength(2);
    expect(trios[0].outcome).toBe('regressed');
    expect(trios[1].outcome).toBe('successful');

    const rounds = rawDb.prepare('SELECT COUNT(*) as n FROM phase_rounds').get() as {
      n: number;
    };
    expect(rounds.n).toBe(6);

    expect(result.report).toContain('TRIOS: 2 (regressed,successful)');
  });
});

describe('runPhase — two regressions with max_trios=2', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => { ({ rawDb, adapter } = setupDb()); });
  afterEach(() => { rawDb.close(); });

  it('phase-partial; 2 trios in DB', async () => {
    const phase = basePhaseInput({ phase_id: 'p_part_001', max_trios: 2 });
    const exec = new TrioScriptedExecutor(
      [
        { plan: [planContinue], impl: [implContinue], qa: [qaFailedEscalate] },
        { plan: [planContinue], impl: [implContinue], qa: [qaFailedEscalate] },
      ],
      (i) => `${phase.phase_id}-t${i + 1}`,
    );

    const result = await runPhase(phase, exec, adapter);

    expect(result.status).toBe('phase-partial');
    expect(result.trios).toHaveLength(2);
    expect(result.trios.map((t) => t.outcome)).toEqual(['regressed', 'regressed']);
    expect(result.report).toContain('STATUS: phase-partial');
    expect(result.report).toContain('NEXT: continue same goal');

    const trios = rawDb.prepare('SELECT COUNT(*) as n FROM phase_trios').get() as { n: number };
    expect(trios.n).toBe(2);
  });
});

describe('runPhase — close-partial on regression', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => { ({ rawDb, adapter } = setupDb()); });
  afterEach(() => { rawDb.close(); });

  it('one regression with on_regression=close-partial -> only 1 trio', async () => {
    const phase = basePhaseInput({
      phase_id: 'p_close_001',
      on_regression: 'close-partial',
    });
    const exec = new StubExecutor({
      plan: [planContinue],
      impl: [implContinue],
      qa: [qaFailedEscalate],
    });

    const result = await runPhase(phase, exec, adapter);

    expect(result.status).toBe('phase-partial');
    expect(result.trios).toHaveLength(1);

    const trios = rawDb.prepare('SELECT COUNT(*) as n FROM phase_trios').get() as { n: number };
    expect(trios.n).toBe(1);
  });
});

describe('runPhase — awaiting-founder', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => { ({ rawDb, adapter } = setupDb()); });
  afterEach(() => { rawDb.close(); });

  it('plan needs-input -> phase-blocked-on-founder; no further trio spawned', async () => {
    const planAsk: RoundReturn = {
      status: 'needs-input',
      summary: 'fork: A or B?',
      findings_written: [],
      commits: [],
    };
    const phase = basePhaseInput({ phase_id: 'p_founder_001' });
    const exec = new StubExecutor({ plan: [planAsk] });

    const result = await runPhase(phase, exec, adapter);

    expect(result.status).toBe('phase-blocked-on-founder');
    expect(result.trios).toHaveLength(1);
    expect(result.report).toContain('NEXT: founder');

    const trios = rawDb.prepare('SELECT outcome FROM phase_trios').all() as Array<{ outcome: string }>;
    expect(trios).toHaveLength(1);
    expect(trios[0].outcome).toBe('awaiting-founder');
  });
});

describe('runPhase — phase-level abort between trios', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => { ({ rawDb, adapter } = setupDb()); });
  afterEach(() => { rawDb.close(); });

  it('first trio regresses, abort fires before trio 2 -> phase-aborted; second trio not spawned', async () => {
    let pollCount = 0;
    // Trio 1 polls abort 3 times (pre-plan, pre-impl, pre-qa); polls 1-3
    // return null. After trio 1 settles regressed, the phase orchestrator
    // polls (call 4) and gets the abort signal.
    const abort: AbortSignalSource = {
      poll: () => {
        pollCount += 1;
        if (pollCount >= 4) return { reason: 'pulse_regression_during_phase' };
        return null;
      },
    };

    const phase = basePhaseInput({ phase_id: 'p_abort_001', abort });
    const exec = new TrioScriptedExecutor(
      [
        { plan: [planContinue], impl: [implContinue], qa: [qaFailedEscalate] },
        // Trio 2 must never be invoked.
        { plan: [planContinue], impl: [implContinue], qa: [qaPassed] },
      ],
      (i) => `${phase.phase_id}-t${i + 1}`,
    );

    const result = await runPhase(phase, exec, adapter);

    expect(result.status).toBe('phase-aborted');
    expect(result.trios).toHaveLength(1);
    expect(result.report).toContain('NEXT: abort');

    // No trio-2 calls
    const trio2Calls = exec.calls.filter((c) => c.trio_id === `${phase.phase_id}-t2`);
    expect(trio2Calls).toHaveLength(0);

    const trios = rawDb.prepare('SELECT COUNT(*) as n FROM phase_trios').get() as { n: number };
    expect(trios.n).toBe(1);
  });
});

describe('runPhase — persistence round-trip', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => { ({ rawDb, adapter } = setupDb()); });
  afterEach(() => { rawDb.close(); });

  it('loadTrio returns rounds in order with deserialised JSON fields', async () => {
    const phase = basePhaseInput({ phase_id: 'p_load_001' });
    const exec = new StubExecutor({
      plan: [planContinue],
      impl: [implContinue],
      qa: [qaPassed],
    });

    await runPhase(phase, exec, adapter);

    const loaded = await loadTrio(adapter, `${phase.phase_id}-t1`);
    expect(loaded).not.toBeNull();
    expect(loaded!.trio.outcome).toBe('successful');
    expect(loaded!.rounds).toHaveLength(3);
    expect(loaded!.rounds.map((r) => r.kind)).toEqual(['plan', 'impl', 'qa']);

    // Plan round: findings_written deserialised to ['f1']
    expect(loaded!.rounds[0].findings_written).toEqual(['f1']);
    // Impl round: commits ['abc1234']
    expect(loaded!.rounds[1].commits).toEqual(['abc1234']);
    // QA round: evaluation block parsed back into shape
    expect(loaded!.rounds[2].evaluation).toEqual({
      verdict: 'passed',
      criteria: [{ criterion: 'tests green', outcome: 'passed' }],
      test_commits: ['def5678'],
      fix_commits: [],
    });
    // raw_return is the full RoundReturn for forensics
    expect(loaded!.rounds[2].raw_return?.evaluation?.verdict).toBe('passed');

    // Unknown trio -> null
    const missing = await loadTrio(adapter, 'does-not-exist');
    expect(missing).toBeNull();
  });
});

describe('runPhase — report shape', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => { ({ rawDb, adapter } = setupDb()); });
  afterEach(() => { rawDb.close(); });

  it('report has exactly 6 lines (5 spec lines, no trailing newline added), ASCII only, goal preserved', async () => {
    const phase = basePhaseInput({
      phase_id: 'p_report_001',
      goal: 'unstick the failing-trigger sweep that breaks heartbeats',
    });
    const exec = new StubExecutor({
      plan: [planContinue],
      impl: [implContinue],
      qa: [qaPassed],
    });

    const result = await runPhase(phase, exec, adapter);

    const lines = result.report.split('\n');
    // 6 line tags in the spec: PHASE, STATUS, TRIOS, SHAS, DELTA, NEXT
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^PHASE: /);
    expect(lines[1]).toMatch(/^STATUS: /);
    expect(lines[2]).toMatch(/^TRIOS: /);
    expect(lines[3]).toMatch(/^SHAS: /);
    expect(lines[4]).toMatch(/^DELTA: /);
    expect(lines[5]).toMatch(/^NEXT: /);

    // Goal not truncated
    expect(lines[0]).toContain('unstick the failing-trigger sweep that breaks heartbeats');

    // ASCII only
    // eslint-disable-next-line no-control-regex
    expect(/[^\x09\x0a\x0d\x20-\x7e]/.test(result.report)).toBe(false);
  });
});

describe('runPhase — wall clock', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => { ({ rawDb, adapter } = setupDb()); });
  afterEach(() => { rawDb.close(); });

  it('max_minutes=0 with executor sleep -> phase-aborted after first trio; NEXT line says abort', async () => {
    // Trio 1 regresses (so the loop continues to a second iteration);
    // by that second iteration ~30ms have passed and the wall-clock
    // check trips before trio 2 is spawned.
    const phase = basePhaseInput({ phase_id: 'p_wc_001', max_minutes: 0 });
    // Use a per-call delay so trio 1 runs but spends measurable time.
    class SlowExec implements RoundExecutor {
      public calls: RoundBrief[] = [];
      async run(brief: RoundBrief): Promise<RoundReturn> {
        this.calls.push(brief);
        await new Promise((r) => setTimeout(r, 10));
        if (brief.kind === 'plan') return planContinue;
        if (brief.kind === 'impl') return implContinue;
        return qaFailedEscalate;
      }
    }
    const exec = new SlowExec();

    const result = await runPhase(phase, exec, adapter);

    expect(result.status).toBe('phase-aborted');
    expect(result.report).toContain('NEXT: abort');
    // Trio 1 ran (3 rounds); trio 2 never spawned.
    expect(exec.calls.filter((c) => c.trio_id === `${phase.phase_id}-t2`)).toHaveLength(0);
    expect(result.trios).toHaveLength(1);
  });
});

describe('runPhase — concurrent phases', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => { ({ rawDb, adapter } = setupDb()); });
  afterEach(() => { rawDb.close(); });

  it('two runPhase calls in parallel against the same DB close cleanly', async () => {
    const execA = new StubExecutor({
      plan: [planContinue],
      impl: [implContinue],
      qa: [qaPassed],
    });
    const execB = new StubExecutor({
      plan: [planContinue],
      impl: [implContinue],
      qa: [qaPassed],
    });

    const [a, b] = await Promise.all([
      runPhase(basePhaseInput({ phase_id: 'p_par_A' }), execA, adapter),
      runPhase(basePhaseInput({ phase_id: 'p_par_B' }), execB, adapter),
    ]);

    expect(a.status).toBe('phase-closed');
    expect(b.status).toBe('phase-closed');

    const ids = (rawDb.prepare('SELECT id FROM phase_trios ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(['p_par_A-t1', 'p_par_B-t1']);

    const roundCount = (rawDb.prepare('SELECT COUNT(*) as n FROM phase_rounds').get() as { n: number }).n;
    expect(roundCount).toBe(6);
  });
});
