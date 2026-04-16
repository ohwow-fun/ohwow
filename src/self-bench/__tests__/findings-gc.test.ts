/**
 * FindingsGcExperiment + pruneOldSuperseded + pruneClosedValidations.
 *
 * Integration tests against a real SQLite DB so the prune helpers exercise
 * actual `.delete().eq().lt()` chains on the SqliteAdapter rather than a
 * shape-only mock. The whole point of this module is to keep the table
 * lean — a mock can't catch a chain that compiles but no-ops on real SQL.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

import { initDatabase } from '../../db/init.js';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import { pruneOldSuperseded } from '../findings-store.js';
import { pruneClosedValidations } from '../validation-store.js';
import { FindingsGcExperiment } from '../experiments/findings-gc.js';
import type { ExperimentContext } from '../experiment-types.js';

interface Env {
  dir: string;
  rawDb: Database.Database;
  db: ReturnType<typeof createSqliteAdapter>;
}

function setupEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ohwow-findings-gc-'));
  const rawDb = initDatabase(join(dir, 'runtime.db'));
  const db = createSqliteAdapter(rawDb);
  return { dir, rawDb, db };
}

function teardownEnv(env: Env): void {
  env.rawDb.close();
  rmSync(env.dir, { recursive: true, force: true });
}

function insertFinding(
  env: Env,
  args: {
    id: string;
    status: 'active' | 'superseded' | 'revoked';
    ranAtIso: string;
    experimentId?: string;
  },
): void {
  env.rawDb
    .prepare(
      `INSERT INTO self_findings
        (id, experiment_id, category, subject, hypothesis, verdict,
         summary, evidence, ran_at, duration_ms, status, created_at)
       VALUES (?, ?, 'other', NULL, NULL, 'warning', 'seed', '{}', ?, 0, ?, ?)`,
    )
    .run(
      args.id,
      args.experimentId ?? 'seed-exp',
      args.ranAtIso,
      args.status,
      args.ranAtIso,
    );
}

function insertValidation(
  env: Env,
  args: {
    id: string;
    status: 'pending' | 'completed' | 'skipped' | 'error';
    completedAtIso: string | null;
  },
): void {
  env.rawDb
    .prepare(
      `INSERT INTO experiment_validations
        (id, intervention_finding_id, experiment_id, baseline, validate_at,
         status, completed_at, created_at)
       VALUES (?, 'fid-1', 'seed-exp', '{}', ?, ?, ?, ?)`,
    )
    .run(
      args.id,
      args.completedAtIso ?? '2026-04-16T00:00:00Z',
      args.status,
      args.completedAtIso,
      '2026-04-16T00:00:00Z',
    );
}

function buildCtx(env: Env): ExperimentContext {
  return {
    db: env.db,
    workspaceId: 'ws-test',
    workspaceSlug: 'default',
    // Engine + scheduler are unused by FindingsGcExperiment.probe; cast away
    // the gaps so the test stays focused on prune semantics.
    engine: undefined as never,
    recentFindings: async () => [],
    scheduler: undefined as never,
  };
}

describe('pruneOldSuperseded', () => {
  let env: Env;
  beforeEach(() => { env = setupEnv(); });
  afterEach(() => teardownEnv(env));

  it('deletes superseded rows older than the cutoff and returns the count', async () => {
    insertFinding(env, { id: 'old-superseded', status: 'superseded', ranAtIso: '2026-04-10T00:00:00Z' });
    insertFinding(env, { id: 'old-active', status: 'active', ranAtIso: '2026-04-10T00:00:00Z' });
    insertFinding(env, { id: 'recent-superseded', status: 'superseded', ranAtIso: '2026-04-16T19:30:00Z' });
    insertFinding(env, { id: 'recent-active', status: 'active', ranAtIso: '2026-04-16T19:30:00Z' });

    const cutoff = '2026-04-15T00:00:00Z';
    const deleted = await pruneOldSuperseded(env.db, cutoff);
    expect(deleted).toBe(1);

    const remaining = env.rawDb.prepare(`SELECT id FROM self_findings ORDER BY id`).all() as Array<{ id: string }>;
    expect(remaining.map((r) => r.id).sort()).toEqual(['old-active', 'recent-active', 'recent-superseded']);
  });

  it('returns 0 and is a no-op when nothing matches the cutoff', async () => {
    insertFinding(env, { id: 'recent', status: 'superseded', ranAtIso: '2026-04-16T19:30:00Z' });
    const deleted = await pruneOldSuperseded(env.db, '2026-04-15T00:00:00Z');
    expect(deleted).toBe(0);
    const count = env.rawDb.prepare(`SELECT COUNT(*) as n FROM self_findings`).get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('never touches active or revoked rows even when they are old', async () => {
    insertFinding(env, { id: 'old-active', status: 'active', ranAtIso: '2026-04-01T00:00:00Z' });
    insertFinding(env, { id: 'old-revoked', status: 'revoked', ranAtIso: '2026-04-01T00:00:00Z' });
    const deleted = await pruneOldSuperseded(env.db, '2026-04-15T00:00:00Z');
    expect(deleted).toBe(0);
    const count = env.rawDb.prepare(`SELECT COUNT(*) as n FROM self_findings`).get() as { n: number };
    expect(count.n).toBe(2);
  });
});

describe('pruneClosedValidations', () => {
  let env: Env;
  beforeEach(() => { env = setupEnv(); });
  afterEach(() => teardownEnv(env));

  it('deletes completed/skipped/error rows older than the cutoff', async () => {
    insertValidation(env, { id: 'old-completed', status: 'completed', completedAtIso: '2026-04-10T00:00:00Z' });
    insertValidation(env, { id: 'old-skipped', status: 'skipped', completedAtIso: '2026-04-10T00:00:00Z' });
    insertValidation(env, { id: 'old-error', status: 'error', completedAtIso: '2026-04-10T00:00:00Z' });
    insertValidation(env, { id: 'recent-completed', status: 'completed', completedAtIso: '2026-04-16T19:30:00Z' });

    const deleted = await pruneClosedValidations(env.db, '2026-04-15T00:00:00Z');
    expect(deleted).toBe(3);
    const remaining = env.rawDb.prepare(`SELECT id FROM experiment_validations ORDER BY id`).all() as Array<{ id: string }>;
    expect(remaining.map((r) => r.id)).toEqual(['recent-completed']);
  });

  it('never deletes pending rows regardless of age', async () => {
    // A 'pending' row carries completed_at=null. The lt('completed_at',...)
    // filter must not catch null on either SQLite or our adapter — verify.
    insertValidation(env, { id: 'old-pending', status: 'pending', completedAtIso: null });
    insertValidation(env, { id: 'old-completed', status: 'completed', completedAtIso: '2026-04-10T00:00:00Z' });
    const deleted = await pruneClosedValidations(env.db, '2026-04-15T00:00:00Z');
    expect(deleted).toBe(1);
    const remaining = env.rawDb.prepare(`SELECT id, status FROM experiment_validations`).all() as Array<{ id: string; status: string }>;
    expect(remaining).toEqual([{ id: 'old-pending', status: 'pending' }]);
  });
});

describe('FindingsGcExperiment', () => {
  let env: Env;
  beforeEach(() => { env = setupEnv(); });
  afterEach(() => teardownEnv(env));

  it('prunes both tables on probe and returns counts in evidence', async () => {
    const fixedNow = Date.parse('2026-04-16T20:00:00Z');
    insertFinding(env, { id: 'old-superseded', status: 'superseded', ranAtIso: '2026-04-10T00:00:00Z' });
    insertFinding(env, { id: 'recent-superseded', status: 'superseded', ranAtIso: '2026-04-16T19:30:00Z' });
    insertValidation(env, { id: 'old-completed', status: 'completed', completedAtIso: '2026-04-10T00:00:00Z' });

    const exp = new FindingsGcExperiment({
      ttlMs: 24 * 60 * 60 * 1000,
      killSwitchPath: join(env.dir, 'no-such-kill-switch'),
      now: () => fixedNow,
    });
    const result = await exp.probe(buildCtx(env));
    const ev = result.evidence as { deleted_findings: number; deleted_validations: number; killed: boolean };
    expect(ev.killed).toBe(false);
    expect(ev.deleted_findings).toBe(1);
    expect(ev.deleted_validations).toBe(1);
    expect(result.summary).toContain('pruned 1 superseded finding(s) + 1 closed validation(s)');
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('respects the kill switch and writes nothing', async () => {
    const killPath = join(env.dir, 'findings-gc-disabled');
    writeFileSync(killPath, '');
    insertFinding(env, { id: 'old-superseded', status: 'superseded', ranAtIso: '2026-04-10T00:00:00Z' });

    const exp = new FindingsGcExperiment({
      killSwitchPath: killPath,
      now: () => Date.parse('2026-04-16T20:00:00Z'),
    });
    const result = await exp.probe(buildCtx(env));
    const ev = result.evidence as { deleted_findings: number; killed: boolean };
    expect(ev.killed).toBe(true);
    expect(ev.deleted_findings).toBe(0);
    expect(result.summary).toContain('kill switch present');
    const count = env.rawDb.prepare(`SELECT COUNT(*) as n FROM self_findings`).get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('reports nothing-to-prune cleanly when the table is fresh', async () => {
    const exp = new FindingsGcExperiment({
      killSwitchPath: join(env.dir, 'no-such-kill-switch'),
      now: () => Date.parse('2026-04-16T20:00:00Z'),
    });
    const result = await exp.probe(buildCtx(env));
    expect(result.summary).toMatch(/^nothing to prune older than /);
    expect(exp.judge(result, [])).toBe('pass');
  });
});
