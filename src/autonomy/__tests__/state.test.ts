/**
 * Tests for the operator surface (Phase 6.7 Deliverable C):
 *   - getConductorState — snapshot of the autonomy stack
 *   - dryRunRanker — what the ranker WOULD return right now
 *
 * Both run against an in-memory SQLite seeded the same way the eval
 * harness does. Cheap reads, never opens an arc, never writes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import { dryRunRanker } from '../dry-run.js';
import { getConductorState } from '../state.js';
import {
  answerFounderQuestion,
  closeArc,
  openArc,
  writeFounderQuestion,
  writePhaseReport,
  updatePhaseReport,
} from '../director-persistence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

function setupDb(): {
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
        /* idempotent */
      }
    }
  }
  const adapter = createSqliteAdapter(rawDb);
  return { rawDb, adapter };
}

describe('getConductorState', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => {
    ({ rawDb, adapter } = setupDb());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rawDb.close();
  });

  it('reflects flag-off by default and reports an empty workspace', async () => {
    vi.stubEnv('OHWOW_AUTONOMY_CONDUCTOR', '0');
    const snap = await getConductorState(adapter, 'ws-test');
    expect(snap.workspace_id).toBe('ws-test');
    expect(snap.flag_on).toBe(false);
    expect(snap.open_arcs).toHaveLength(0);
    expect(snap.recent_arcs).toHaveLength(0);
    expect(snap.recent_phase_reports).toHaveLength(0);
    expect(snap.open_inbox_count).toBe(0);
    expect(snap.answered_unresolved_inbox_count).toBe(0);
    expect(snap.failing_triggers_count).toBe(0);
    expect(snap.pending_approvals_count).toBe(0);
  });

  it('reflects flag-on when env is set', async () => {
    vi.stubEnv('OHWOW_AUTONOMY_CONDUCTOR', '1');
    const snap = await getConductorState(adapter, 'ws-test');
    expect(snap.flag_on).toBe(true);
  });

  it('surfaces an open arc with budget + elapsed minutes + phases_run', async () => {
    vi.stubEnv('OHWOW_AUTONOMY_CONDUCTOR', '1');
    const openedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    await openArc(adapter, {
      id: 'arc_open_1',
      workspace_id: 'ws-test',
      mode_of_invocation: 'loop-tick',
      thesis: 'autonomous: scan',
      budget_max_phases: 6,
      budget_max_minutes: 240,
      budget_max_inbox_qs: 3,
      kill_on_pulse_regression: true,
      pulse_at_entry: { ts: openedAt },
      opened_at: openedAt,
    });
    await writePhaseReport(adapter, {
      id: 'pr_1',
      arc_id: 'arc_open_1',
      workspace_id: 'ws-test',
      phase_id: 'p1_20260418000000_revenue_approval_ap_x_1',
      mode: 'revenue',
      goal: 'fire approval ap_x [source=approval; id=ap_x]',
      status: 'in-flight',
      started_at: openedAt,
    });
    const snap = await getConductorState(adapter, 'ws-test');
    expect(snap.open_arcs).toHaveLength(1);
    const a = snap.open_arcs[0];
    expect(a.arc_id).toBe('arc_open_1');
    expect(a.budget.max_phases).toBe(6);
    expect(a.phases_run).toBe(1);
    expect(a.phases_remaining).toBe(5);
    expect(a.elapsed_minutes).toBeGreaterThanOrEqual(29);
  });

  it('surfaces recent closed arcs, sorted newest first, with phases_run', async () => {
    vi.stubEnv('OHWOW_AUTONOMY_CONDUCTOR', '1');
    const t0 = Date.now();
    for (let i = 0; i < 7; i++) {
      const id = `arc_${i}`;
      const opened = new Date(t0 - (10 - i) * 60_000).toISOString();
      const closed = new Date(t0 - (10 - i) * 60_000 + 1000).toISOString();
      await openArc(adapter, {
        id,
        workspace_id: 'ws-test',
        mode_of_invocation: 'loop-tick',
        thesis: `arc ${i}`,
        budget_max_phases: 6,
        budget_max_minutes: 240,
        budget_max_inbox_qs: 3,
        kill_on_pulse_regression: true,
        pulse_at_entry: { ts: opened },
        opened_at: opened,
      });
      await closeArc(adapter, {
        id,
        status: 'closed',
        exit_reason: 'nothing-queued',
        pulse_at_close: { ts: closed },
        closed_at: closed,
      });
    }
    const snap = await getConductorState(adapter, 'ws-test');
    // Cap is 5.
    expect(snap.recent_arcs).toHaveLength(5);
    // Newest first by closed_at — arc_6 then arc_5 ...
    expect(snap.recent_arcs[0].arc_id).toBe('arc_6');
    expect(snap.recent_arcs[4].arc_id).toBe('arc_2');
    for (const a of snap.recent_arcs) {
      expect(a.status).toBe('closed');
      expect(a.exit_reason).toBe('nothing-queued');
    }
  });

  it('counts open + answered-unresolved inbox rows', async () => {
    vi.stubEnv('OHWOW_AUTONOMY_CONDUCTOR', '1');
    await writeFounderQuestion(adapter, {
      id: 'fi_open',
      workspace_id: 'ws-test',
      arc_id: null,
      phase_id: null,
      mode: 'plumbing',
      blocker: 'open question',
      context: '',
      options: [],
      recommended: null,
      screenshot_path: null,
      asked_at: new Date().toISOString(),
    });
    await writeFounderQuestion(adapter, {
      id: 'fi_answered',
      workspace_id: 'ws-test',
      arc_id: null,
      phase_id: null,
      mode: 'plumbing',
      blocker: 'answered question',
      context: '',
      options: [],
      recommended: null,
      screenshot_path: null,
      asked_at: new Date().toISOString(),
    });
    await answerFounderQuestion(adapter, {
      id: 'fi_answered',
      answer: 'go',
      answered_at: new Date().toISOString(),
    });
    const snap = await getConductorState(adapter, 'ws-test');
    expect(snap.open_inbox_count).toBe(1);
    expect(snap.answered_unresolved_inbox_count).toBe(1);
  });
});

describe('dryRunRanker', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => {
    ({ rawDb, adapter } = setupDb());
  });
  afterEach(() => {
    rawDb.close();
  });

  it('returns empty for an empty workspace and writes nothing', async () => {
    const snap = await dryRunRanker(adapter, 'ws-test');
    expect(snap.workspace_id).toBe('ws-test');
    expect(snap.candidates).toHaveLength(0);
    expect(snap.total_candidates).toBe(0);
    expect(snap.pre_seed_inbox_count).toBe(0);

    // No arcs were created.
    const arcs = rawDb
      .prepare('SELECT id FROM director_arcs')
      .all() as Array<{ id: string }>;
    expect(arcs).toHaveLength(0);
  });

  it('surfaces a pending approval with a positive score', async () => {
    const askedIso = new Date(Date.now() - 6 * 3_600_000).toISOString();
    rawDb
      .prepare(
        `INSERT INTO agent_workforce_tasks (id, workspace_id, agent_id, title, description, status, priority, requires_approval, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'ap_dryrun',
        'ws-test',
        'eval-agent',
        'fire approval',
        'fire approval',
        'needs_approval',
        'normal',
        1,
        askedIso,
        askedIso,
      );
    const snap = await dryRunRanker(adapter, 'ws-test');
    expect(snap.candidates.length).toBeGreaterThanOrEqual(1);
    const top = snap.candidates[0];
    expect(top.source).toBe('approval');
    expect(top.score).toBeGreaterThan(0);
    expect(top.goal).toContain('ap_dryrun');
  });

  it('respects the limit option', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const askedIso = new Date(now - (i + 1) * 3_600_000).toISOString();
      rawDb
        .prepare(
          `INSERT INTO agent_workforce_tasks (id, workspace_id, agent_id, title, description, status, priority, requires_approval, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          `ap_${i}`,
          'ws-test',
          'eval-agent',
          `approval ${i}`,
          `approval ${i}`,
          'needs_approval',
          'normal',
          1,
          askedIso,
          askedIso,
        );
    }
    const snap = await dryRunRanker(adapter, 'ws-test', { limit: 2 });
    expect(snap.candidates).toHaveLength(2);
    expect(snap.total_candidates).toBe(5);
  });

  it('counts pre-seed inbox rows', async () => {
    await writeFounderQuestion(adapter, {
      id: 'fi_pre',
      workspace_id: 'ws-test',
      arc_id: null,
      phase_id: null,
      mode: 'plumbing',
      blocker: 'pre-seed',
      context: '',
      options: [],
      recommended: null,
      screenshot_path: null,
      asked_at: new Date().toISOString(),
    });
    await answerFounderQuestion(adapter, {
      id: 'fi_pre',
      answer: 'go',
      answered_at: new Date().toISOString(),
    });
    const snap = await dryRunRanker(adapter, 'ws-test');
    expect(snap.pre_seed_inbox_count).toBe(1);
    // The founder-answer candidate is emitted at score 200+.
    expect(snap.candidates.length).toBeGreaterThanOrEqual(1);
    const top = snap.candidates[0];
    expect(top.source).toBe('founder-answer');
    expect(top.source_id).toBe('fi_pre');
  });
});
