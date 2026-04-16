/**
 * ExperimentCostObserverExperiment — integration tests against a real
 * SQLite DB so the per-experiment rollup exercises actual GROUP BY on
 * a real schema (post migration 132). The whole point of this observer
 * is the join with self_findings warning|fail counts; a mock would
 * have to reimplement that logic.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

import { initDatabase } from '../../db/init.js';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import {
  ExperimentCostObserverExperiment,
  type ExperimentCostEvidence,
} from '../experiments/experiment-cost-observer.js';
import type { ExperimentContext } from '../experiment-types.js';

const WORKSPACE_ID = 'ws-cost-obs-test';

interface Env {
  dir: string;
  rawDb: Database.Database;
  db: ReturnType<typeof createSqliteAdapter>;
}

function setupEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ohwow-cost-obs-'));
  const rawDb = initDatabase(join(dir, 'runtime.db'));
  const db = createSqliteAdapter(rawDb);
  return { dir, rawDb, db };
}

function teardownEnv(env: Env): void {
  env.rawDb.close();
  rmSync(env.dir, { recursive: true, force: true });
}

function insertCall(env: Env, args: {
  id: string;
  experimentId: string | null;
  costCents: number;
  createdAtIso?: string;
  workspaceId?: string;
}): void {
  env.rawDb
    .prepare(
      `INSERT INTO llm_calls
        (id, workspace_id, agent_id, task_id, experiment_id, purpose,
         provider, model, input_tokens, output_tokens, cost_cents,
         latency_ms, success, created_at)
       VALUES (?, ?, NULL, NULL, ?, 'reasoning', 'openrouter', 'm', 100, 200, ?, 500, 1, ?)`,
    )
    .run(
      args.id,
      args.workspaceId ?? WORKSPACE_ID,
      args.experimentId,
      args.costCents,
      args.createdAtIso ?? new Date().toISOString(),
    );
}

function insertFinding(env: Env, args: {
  id: string;
  experimentId: string;
  verdict: 'pass' | 'warning' | 'fail' | 'error';
  ranAtIso?: string;
}): void {
  const now = args.ranAtIso ?? new Date().toISOString();
  env.rawDb
    .prepare(
      `INSERT INTO self_findings
        (id, experiment_id, category, subject, hypothesis, verdict,
         summary, evidence, ran_at, duration_ms, status, created_at)
       VALUES (?, ?, 'other', NULL, NULL, ?, 'seed', '{}', ?, 0, 'active', ?)`,
    )
    .run(args.id, args.experimentId, args.verdict, now, now);
}

function buildCtx(env: Env): ExperimentContext {
  return {
    db: env.db,
    workspaceId: WORKSPACE_ID,
    workspaceSlug: 'default',
    engine: undefined as never,
    recentFindings: async () => [],
    scheduler: undefined as never,
  };
}

describe('ExperimentCostObserverExperiment', () => {
  let env: Env;
  beforeEach(() => { env = setupEnv(); });
  afterEach(() => teardownEnv(env));

  it('rolls up cost per experiment_id and sorts top spenders descending', async () => {
    insertCall(env, { id: 'c1', experimentId: 'patch-author', costCents: 50 });
    insertCall(env, { id: 'c2', experimentId: 'patch-author', costCents: 30 });
    insertCall(env, { id: 'c3', experimentId: 'roadmap-updater', costCents: 12 });
    insertCall(env, { id: 'c4', experimentId: 'experiment-author', costCents: 5 });

    const exp = new ExperimentCostObserverExperiment();
    const result = await exp.probe(buildCtx(env));
    const ev = result.evidence as ExperimentCostEvidence;

    expect(ev.experiments_observed).toBe(3);
    expect(ev.top_spenders[0]).toMatchObject({ experiment_id: 'patch-author', total_cents: 80, call_count: 2 });
    expect(ev.top_spenders[1]).toMatchObject({ experiment_id: 'roadmap-updater', total_cents: 12 });
    expect(ev.top_spenders[2]).toMatchObject({ experiment_id: 'experiment-author', total_cents: 5 });
  });

  it('counts warning|fail findings per experiment in the same window', async () => {
    insertCall(env, { id: 'c1', experimentId: 'patch-author', costCents: 50 });
    insertFinding(env, { id: 'f1', experimentId: 'patch-author', verdict: 'warning' });
    insertFinding(env, { id: 'f2', experimentId: 'patch-author', verdict: 'fail' });
    insertFinding(env, { id: 'f3', experimentId: 'patch-author', verdict: 'pass' }); // ignored
    insertFinding(env, { id: 'f4', experimentId: 'other', verdict: 'warning' }); // wrong experiment

    const exp = new ExperimentCostObserverExperiment();
    const result = await exp.probe(buildCtx(env));
    const ev = result.evidence as ExperimentCostEvidence;
    expect(ev.top_spenders[0].warning_fail_count).toBe(2);
  });

  it('flags experiments spending above floor with zero warning|fail findings', async () => {
    // patch-author: 80¢, has signal → not flagged
    insertCall(env, { id: 'c1', experimentId: 'patch-author', costCents: 80 });
    insertFinding(env, { id: 'f1', experimentId: 'patch-author', verdict: 'warning' });
    // expensive-loop: 50¢, ZERO signal → flagged
    insertCall(env, { id: 'c2', experimentId: 'expensive-loop', costCents: 50 });
    // tiny-spender: 5¢, ZERO signal but BELOW floor → not flagged
    insertCall(env, { id: 'c3', experimentId: 'tiny-spender', costCents: 5 });

    const exp = new ExperimentCostObserverExperiment();
    const result = await exp.probe(buildCtx(env));
    const ev = result.evidence as ExperimentCostEvidence;

    expect(ev.spending_without_signal).toHaveLength(1);
    expect(ev.spending_without_signal[0]).toMatchObject({
      experiment_id: 'expensive-loop',
      total_cents: 50,
      warning_fail_count: 0,
    });
    expect(exp.judge(result, [])).toBe('warning');
    expect(result.summary).toContain('1 experiment(s) spending without signal');
  });

  it('reports unattributed cost separately from per-experiment totals', async () => {
    // Pre-migration calls or non-experiment paths arrive with experiment_id=null.
    // They must not be merged into a fake "null" experiment row.
    insertCall(env, { id: 'c1', experimentId: null, costCents: 25 });
    insertCall(env, { id: 'c2', experimentId: null, costCents: 17 });
    insertCall(env, { id: 'c3', experimentId: 'patch-author', costCents: 5 });

    const exp = new ExperimentCostObserverExperiment();
    const result = await exp.probe(buildCtx(env));
    const ev = result.evidence as ExperimentCostEvidence;
    expect(ev.unattributed_cents).toBe(42);
    expect(ev.unattributed_calls).toBe(2);
    expect(ev.top_spenders).toHaveLength(1);
    expect(ev.top_spenders[0].experiment_id).toBe('patch-author');
  });

  it('scopes the rollup to the active workspace', async () => {
    insertCall(env, { id: 'c1', experimentId: 'patch-author', costCents: 50 });
    // Same experiment id, different workspace — must be invisible.
    insertCall(env, { id: 'c2', experimentId: 'patch-author', costCents: 999, workspaceId: 'other-ws' });

    const exp = new ExperimentCostObserverExperiment();
    const result = await exp.probe(buildCtx(env));
    const ev = result.evidence as ExperimentCostEvidence;
    expect(ev.top_spenders[0].total_cents).toBe(50);
  });

  it('passes when nothing is spending without signal', async () => {
    insertCall(env, { id: 'c1', experimentId: 'patch-author', costCents: 50 });
    insertFinding(env, { id: 'f1', experimentId: 'patch-author', verdict: 'warning' });
    const exp = new ExperimentCostObserverExperiment();
    const result = await exp.probe(buildCtx(env));
    expect(exp.judge(result, [])).toBe('pass');
    expect(result.summary).toContain('no spending-without-signal cases');
  });
});
