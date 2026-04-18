/**
 * LlmBudgetPulseExperiment tests — gap 13 pulse pin.
 *
 * Integration-style: spin up a real SQLite DB with the full schema so
 * the 7-day llm_calls aggregation, origin='autonomous' filter, and
 * day-key dedupe against self_findings all exercise the actual tables
 * and row shapes the probe() reads in production.
 *
 * Pattern cloned from experiment-cost-observer.test.ts — the sibling
 * observer tests use the same mkdtemp + initDatabase harness. Keeping
 * the shape parallel makes the self-bench test family easier to grok.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

import { initDatabase } from '../../db/init.js';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import {
  LlmBudgetPulseExperiment,
  type LlmBudgetPulseEvidence,
} from '../experiments/llm-budget-pulse.js';
import type { ExperimentContext } from '../experiment-types.js';

const WORKSPACE_ID = 'ws-budget-pulse-test';

interface Env {
  dir: string;
  rawDb: Database.Database;
  db: ReturnType<typeof createSqliteAdapter>;
}

function setupEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ohwow-budget-pulse-'));
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
  origin?: string;
  createdAtIso?: string;
  workspaceId?: string;
}): void {
  env.rawDb
    .prepare(
      `INSERT INTO llm_calls
        (id, workspace_id, agent_id, task_id, experiment_id, purpose,
         provider, model, input_tokens, output_tokens, cost_cents,
         latency_ms, success, created_at, origin)
       VALUES (?, ?, NULL, NULL, ?, 'reasoning', 'openrouter', 'm', 100, 200, ?, 500, 1, ?, ?)`,
    )
    .run(
      args.id,
      args.workspaceId ?? WORKSPACE_ID,
      args.experimentId,
      args.costCents,
      args.createdAtIso ?? new Date().toISOString(),
      args.origin ?? 'autonomous',
    );
}

function insertFinding(env: Env, args: {
  id: string;
  experimentId: string;
  subject: string;
  ranAtIso: string;
  verdict?: 'pass' | 'warning' | 'fail' | 'error';
}): void {
  env.rawDb
    .prepare(
      `INSERT INTO self_findings
        (id, experiment_id, category, subject, hypothesis, verdict,
         summary, evidence, ran_at, duration_ms, status, created_at)
       VALUES (?, ?, 'other', ?, NULL, ?, 'seed', '{}', ?, 0, 'active', ?)`,
    )
    .run(
      args.id,
      args.experimentId,
      args.subject,
      args.verdict ?? 'pass',
      args.ranAtIso,
      args.ranAtIso,
    );
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

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('LlmBudgetPulseExperiment', () => {
  let env: Env;
  beforeEach(() => { env = setupEnv(); });
  afterEach(() => teardownEnv(env));

  it('emits finding with subject `llm-budget:<YYYY-MM-DD>` summing autonomous 7d spend', async () => {
    const now = Date.now();
    // 3 autonomous calls today, 50+30+20 = 100¢
    insertCall(env, { id: 'c1', experimentId: 'patch-author', costCents: 50, createdAtIso: new Date(now - 60_000).toISOString() });
    insertCall(env, { id: 'c2', experimentId: 'patch-author', costCents: 30, createdAtIso: new Date(now - 120_000).toISOString() });
    insertCall(env, { id: 'c3', experimentId: 'roadmap-updater', costCents: 20, createdAtIso: new Date(now - 180_000).toISOString() });

    const exp = new LlmBudgetPulseExperiment();
    const result = await exp.probe(buildCtx(env));
    const ev = result.evidence as LlmBudgetPulseEvidence;

    expect(result.subject).toBe(`llm-budget:${todayKey()}`);
    expect(ev.span_days).toBe(7);
    expect(ev.total_cents_7d).toBe(100);
    expect(ev.cents_today).toBe(100);
    expect(ev.autonomous_call_count).toBe(3);
    expect(exp.judge(result, [])).toBe('pass'); // observer-only
  });

  it('dedupes within the same UTC day when a prior finding exists for the experiment', async () => {
    const now = Date.now();
    insertCall(env, { id: 'c1', experimentId: 'patch-author', costCents: 50, createdAtIso: new Date(now - 60_000).toISOString() });
    insertFinding(env, {
      id: 'prior',
      experimentId: 'llm-budget-pulse',
      subject: `llm-budget:${todayKey()}`,
      ranAtIso: new Date(now - 5 * 60_000).toISOString(), // 5 min ago, same UTC day
    });

    const exp = new LlmBudgetPulseExperiment();
    const result = await exp.probe(buildCtx(env));

    // Dedupe path stamps skipped:true in evidence and leaves span_days=7.
    const ev = result.evidence as LlmBudgetPulseEvidence & { skipped?: boolean };
    expect(ev.skipped).toBe(true);
    expect(result.summary.toLowerCase()).toContain('already landed this utc day');
    // Dedupe summary must not contain an em/en dash per the house style.
    expect(result.summary).not.toMatch(/—|–/);
  });

  it('excludes llm_calls older than the 7-day window', async () => {
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    // Inside 7d: 40¢
    insertCall(env, { id: 'recent', experimentId: 'patch-author', costCents: 40, createdAtIso: new Date(now - 3 * DAY_MS).toISOString() });
    // Outside 7d (10 days ago): must be invisible to the rollup.
    insertCall(env, { id: 'old', experimentId: 'patch-author', costCents: 999, createdAtIso: new Date(now - 10 * DAY_MS).toISOString() });

    const exp = new LlmBudgetPulseExperiment();
    const result = await exp.probe(buildCtx(env));
    const ev = result.evidence as LlmBudgetPulseEvidence;

    expect(ev.total_cents_7d).toBe(40);
    expect(ev.autonomous_call_count).toBe(1);
  });

  it('ignores non-autonomous origin rows (e.g. interactive dashboard calls)', async () => {
    insertCall(env, { id: 'auto', experimentId: 'patch-author', costCents: 30 });
    insertCall(env, { id: 'user', experimentId: 'patch-author', costCents: 900, origin: 'user' });
    insertCall(env, { id: 'interactive', experimentId: 'patch-author', costCents: 500, origin: 'interactive' });

    const exp = new LlmBudgetPulseExperiment();
    const result = await exp.probe(buildCtx(env));
    const ev = result.evidence as LlmBudgetPulseEvidence;

    expect(ev.total_cents_7d).toBe(30);
    expect(ev.autonomous_call_count).toBe(1);
  });

  it('ranks the top-3 experiments by cost_cents descending', async () => {
    insertCall(env, { id: 'a1', experimentId: 'exp-a', costCents: 10 });
    insertCall(env, { id: 'b1', experimentId: 'exp-b', costCents: 100 });
    insertCall(env, { id: 'b2', experimentId: 'exp-b', costCents: 20 });  // exp-b: 120¢ total
    insertCall(env, { id: 'c1', experimentId: 'exp-c', costCents: 50 });
    insertCall(env, { id: 'd1', experimentId: 'exp-d', costCents: 80 });
    insertCall(env, { id: 'e1', experimentId: 'exp-e', costCents: 5 });

    const exp = new LlmBudgetPulseExperiment();
    const result = await exp.probe(buildCtx(env));
    const ev = result.evidence as LlmBudgetPulseEvidence;

    expect(ev.top_experiments).toHaveLength(3);
    expect(ev.top_experiments[0]).toMatchObject({ id: 'exp-b', cents: 120 });
    expect(ev.top_experiments[1]).toMatchObject({ id: 'exp-d', cents: 80 });
    expect(ev.top_experiments[2]).toMatchObject({ id: 'exp-c', cents: 50 });
    // exp-a (10¢) and exp-e (5¢) must not appear.
    expect(ev.top_experiments.find((e) => e.id === 'exp-a')).toBeUndefined();
    expect(ev.top_experiments.find((e) => e.id === 'exp-e')).toBeUndefined();
  });

  it('groups unattributed (null experiment_id) rows under "unattributed"', async () => {
    insertCall(env, { id: 'u1', experimentId: null, costCents: 25 });
    insertCall(env, { id: 'u2', experimentId: null, costCents: 15 });
    insertCall(env, { id: 'att', experimentId: 'patch-author', costCents: 5 });

    const exp = new LlmBudgetPulseExperiment();
    const result = await exp.probe(buildCtx(env));
    const ev = result.evidence as LlmBudgetPulseEvidence;

    const unattributed = ev.top_experiments.find((e) => e.id === 'unattributed');
    expect(unattributed).toBeDefined();
    expect(unattributed?.cents).toBe(40);
  });

  it('scopes the rollup to the active workspace', async () => {
    insertCall(env, { id: 'mine', experimentId: 'patch-author', costCents: 50 });
    // Same experiment, different workspace — must be invisible.
    insertCall(env, { id: 'theirs', experimentId: 'patch-author', costCents: 999, workspaceId: 'ws-other' });

    const exp = new LlmBudgetPulseExperiment();
    const result = await exp.probe(buildCtx(env));
    const ev = result.evidence as LlmBudgetPulseEvidence;

    expect(ev.total_cents_7d).toBe(50);
  });

  it('emits zero-spend finding when no autonomous rows exist in the window', async () => {
    // No calls at all.
    const exp = new LlmBudgetPulseExperiment();
    const result = await exp.probe(buildCtx(env));
    const ev = result.evidence as LlmBudgetPulseEvidence;

    expect(ev.total_cents_7d).toBe(0);
    expect(ev.cents_today).toBe(0);
    expect(ev.autonomous_call_count).toBe(0);
    expect(ev.top_experiments).toEqual([]);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('carries runOnBoot=true with a 60-minute cadence', () => {
    const exp = new LlmBudgetPulseExperiment();
    expect(exp.cadence.everyMs).toBe(60 * 60 * 1000);
    expect(exp.cadence.runOnBoot).toBe(true);
    expect(exp.id).toBe('llm-budget-pulse');
  });
});
