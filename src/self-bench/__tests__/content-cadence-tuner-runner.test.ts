/**
 * Integration test: ContentCadenceTunerExperiment driven by a real
 * ExperimentRunner against a real SQLite DB with the full self-bench
 * schema migrated.
 *
 * Why this exists
 * ---------------
 * The unit tests in content-cadence-tuner.test.ts cover probe / judge /
 * intervene / validate / rollback in isolation with a hand-rolled DB
 * stub. They catch logic bugs inside each method but they don't catch
 * evidence-shape mismatches between what intervene stores in
 * InterventionApplied.details and what validate later reads back from
 * the enqueued baseline JSON — that round-trip goes through
 * enqueueValidation (JSON.stringify) and readDueValidations
 * (JSON.parse), and a wrong key name would silently produce 'inconclusive'
 * validations forever.
 *
 * This test exercises the full loop end-to-end:
 *   tick 1 → probe → judge=warning → intervene → runtime_config written
 *          → self_findings row (business_outcome)
 *          → experiment_validations row enqueued
 *   advance clock past validationDelayMs
 *   tick 2 → processValidationQueue → validate(baseline, ctx)
 *          → self_findings row (validation)
 *          → (happy path) outcome='held'; no rollback
 *          → (failure path) outcome='failed' → runner calls rollback
 *                         → runtime_config deleted
 *                         → self_findings row (validation, is_rollback)
 *
 * Uses a real better-sqlite3 DB file + createSqliteAdapter so the
 * fluent query builder behaves exactly like production. Uses
 * initDatabase so the schema migrates from zero the same way the
 * daemon does on first boot.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

import { initDatabase } from '../../db/init.js';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import { ExperimentRunner } from '../experiment-runner.js';
import {
  ContentCadenceTunerExperiment,
  CONTENT_CADENCE_CONFIG_KEY,
  CONTENT_CADENCE_DEFAULT,
  CONTENT_CADENCE_GOAL_METRIC,
  currentContentCadence,
} from '../experiments/content-cadence-tuner.js';
import { _resetRuntimeConfigCacheForTests } from '../runtime-config.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { RuntimeEngine } from '../../execution/engine.js';

/**
 * Subclass the tuner so the test can control cadence tightly:
 *   - runOnBoot: true so tick 1 fires immediately
 *   - everyMs well beyond the test window so tick 2 does NOT re-run
 *     the probe (keeps assertions on finding counts predictable)
 *   - validationDelayMs: 60s so advancing the mocked clock by 90s
 *     flushes the validation queue
 */
class TestTuner extends ContentCadenceTunerExperiment {
  cadence = {
    everyMs: 10 * 60 * 60 * 1000,
    runOnBoot: true,
    validationDelayMs: 60 * 1000,
  };
}

const WORKSPACE_ID = 'ws-row-id-1';
const WORKSPACE_SLUG = 'default';
const GOAL_ID = 'goal-x-posts-week';

interface Env {
  dir: string;
  rawDb: Database.Database;
  db: DatabaseAdapter;
}

function setupEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ohwow-cadence-integ-'));
  const rawDb = initDatabase(join(dir, 'runtime.db'));
  const db = createSqliteAdapter(rawDb);
  return { dir, rawDb, db };
}

function teardownEnv(env: Env): void {
  env.rawDb.close();
  rmSync(env.dir, { recursive: true, force: true });
}

/**
 * Seed an active goal with a real, in-the-future due date. We use the
 * real Date.now() here (not the mocked runner clock) because
 * content-cadence-tuner's probe calls computeRequiredVelocity with a
 * fresh `new Date()` — the goal's due_date must be in the future
 * relative to the real wall clock at probe time, not the runner's
 * mocked tick clock.
 */
function seedGoal(
  rawDb: Database.Database,
  opts: { targetValue: number; currentValue: number; daysAhead: number },
): void {
  // Pad with +1h so the few ms of real time between seeding and
  // probing don't push `daysRemaining` just under an integer and
  // bump Math.ceil(required_per_day) up by one. With 14/7 we want
  // ceil(~2.0) = 2, not ceil(2.00001) = 3.
  const dueDate = new Date(
    Date.now() + opts.daysAhead * 24 * 60 * 60 * 1000 + 60 * 60 * 1000,
  ).toISOString();
  rawDb
    .prepare(
      `INSERT INTO agent_workforce_goals
        (id, workspace_id, title, target_metric, target_value, current_value, unit, status, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(
      GOAL_ID,
      WORKSPACE_ID,
      'Ship X posts this week',
      CONTENT_CADENCE_GOAL_METRIC,
      opts.targetValue,
      opts.currentValue,
      'posts',
      dueDate,
    );
}

function updateGoalCurrent(rawDb: Database.Database, value: number): void {
  rawDb
    .prepare('UPDATE agent_workforce_goals SET current_value = ? WHERE id = ?')
    .run(value, GOAL_ID);
}

function countFindings(rawDb: Database.Database, category?: string): number {
  if (category) {
    return (
      rawDb
        .prepare('SELECT COUNT(*) as n FROM self_findings WHERE category = ?')
        .get(category) as { n: number }
    ).n;
  }
  return (rawDb.prepare('SELECT COUNT(*) as n FROM self_findings').get() as { n: number }).n;
}

describe('ContentCadenceTunerExperiment — runner integration', () => {
  let env: Env;
  let currentTime: number;
  let runner: ExperimentRunner;

  beforeEach(() => {
    _resetRuntimeConfigCacheForTests();
    env = setupEnv();
    // Pin to real-ish epoch so ISO string comparisons in
    // readDueValidations behave naturally alongside validate_at
    // strings generated from the same clock.
    currentTime = Date.now();
    runner = new ExperimentRunner(
      env.db,
      {} as unknown as RuntimeEngine,
      WORKSPACE_ID,
      WORKSPACE_SLUG,
      { tickIntervalMs: 60_000, now: () => currentTime },
    );
  });

  afterEach(() => {
    teardownEnv(env);
  });

  it('happy path: probe → intervene → validate held (end-to-end)', async () => {
    // Goal behind velocity: 14 posts needed in 7 days → 2/day.
    seedGoal(env.rawDb, { targetValue: 14, currentValue: 0, daysAhead: 7 });
    runner.register(new TestTuner());

    // Tick 1: probe fires on boot, judges warning, intervenes.
    await runner.tick();

    // Intervention landed a finding + a runtime_config row + a pending validation.
    expect(countFindings(env.rawDb, 'business_outcome')).toBe(1);
    expect(currentContentCadence()).toBe(2);

    const configRows = env.rawDb
      .prepare('SELECT key, value, set_by FROM runtime_config_overrides')
      .all() as Array<{ key: string; value: string; set_by: string }>;
    expect(configRows).toHaveLength(1);
    expect(configRows[0].key).toBe(CONTENT_CADENCE_CONFIG_KEY);
    expect(JSON.parse(configRows[0].value)).toBe(2);
    expect(configRows[0].set_by).toBe('content-cadence-tuner');

    const pending = env.rawDb
      .prepare('SELECT * FROM experiment_validations')
      .all() as Array<{
        status: string;
        experiment_id: string;
        baseline: string;
        validate_at: string;
      }>;
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('pending');
    expect(pending[0].experiment_id).toBe('content-cadence-tuner');

    // The key assertion this test exists to catch: the baseline
    // JSON that validate() will consume must contain goal_id +
    // required_per_day + goal_current_value_at_intervention. If
    // intervene stored them under different keys, validate would
    // read undefined and return inconclusive forever.
    const baseline = JSON.parse(pending[0].baseline);
    expect(baseline.goal_id).toBe(GOAL_ID);
    expect(baseline.required_per_day).toBeGreaterThan(0);
    expect(baseline.goal_current_value_at_intervention).toBe(0);
    expect(baseline.old_value).toBe(CONTENT_CADENCE_DEFAULT);
    expect(baseline.new_value).toBe(2);

    // Simulate the downstream scheduler (which we haven't wired yet)
    // actually posting: goal moves by 2 over the validation window,
    // meeting the floor (required_per_day * 0.5 = 1).
    updateGoalCurrent(env.rawDb, 2);

    // Advance past validationDelayMs and tick again. The experiment
    // itself won't re-run (everyMs is 10h) so the only thing that
    // happens on this tick is the validation queue drain.
    currentTime += 90 * 1000;
    await runner.tick();

    const validationRows = env.rawDb
      .prepare('SELECT * FROM experiment_validations')
      .all() as Array<{ status: string; outcome: string | null; outcome_finding_id: string }>;
    expect(validationRows).toHaveLength(1);
    expect(validationRows[0].status).toBe('completed');
    expect(validationRows[0].outcome).toBe('held');
    expect(validationRows[0].outcome_finding_id).toBeTruthy();

    // self_findings should now have the original business_outcome row
    // PLUS the validation finding. No rollback (outcome held).
    expect(countFindings(env.rawDb, 'validation')).toBe(1);
    const validationFinding = env.rawDb
      .prepare("SELECT * FROM self_findings WHERE category = 'validation'")
      .get() as { verdict: string; evidence: string; subject: string };
    expect(validationFinding.verdict).toBe('pass');
    expect(validationFinding.subject).toContain('intervention:');

    // Runtime config knob remains in place (intervention held).
    const stillThere = env.rawDb
      .prepare('SELECT COUNT(*) as n FROM runtime_config_overrides')
      .get() as { n: number };
    expect(stillThere.n).toBe(1);
    expect(currentContentCadence()).toBe(2);
  });

  it('failure path: probe → intervene → validate failed → rollback deletes knob', async () => {
    seedGoal(env.rawDb, { targetValue: 14, currentValue: 0, daysAhead: 7 });
    runner.register(new TestTuner());

    await runner.tick();
    expect(currentContentCadence()).toBe(2);
    expect(
      env.rawDb.prepare('SELECT COUNT(*) as n FROM experiment_validations').get(),
    ).toEqual({ n: 1 });

    // Do NOT update the goal. The downstream scheduler didn't post,
    // so current_value stays at 0 and the widening is a no-op. This
    // is the expected state today (no consumer wired yet) — the
    // experiment correctly reports its lever is dead.
    currentTime += 90 * 1000;
    await runner.tick();

    const validationRow = env.rawDb
      .prepare('SELECT * FROM experiment_validations')
      .get() as { status: string; outcome: string | null };
    expect(validationRow.status).toBe('completed');
    expect(validationRow.outcome).toBe('failed');

    // Validation finding (verdict=fail) + rollback finding (verdict=warning).
    // Both are written in the same mocked-clock tick so ran_at is
    // identical — distinguish them by verdict + evidence shape, not
    // by ordering.
    const validationFindings = env.rawDb
      .prepare("SELECT verdict, evidence FROM self_findings WHERE category = 'validation'")
      .all() as Array<{ verdict: string; evidence: string }>;
    expect(validationFindings).toHaveLength(2);
    const outcomeRow = validationFindings.find((f) => f.verdict === 'fail');
    const rollbackRow = validationFindings.find((f) => f.verdict === 'warning');
    expect(outcomeRow).toBeDefined();
    expect(rollbackRow).toBeDefined();
    const outcomeEvidence = JSON.parse(outcomeRow!.evidence) as {
      is_validation?: boolean;
      outcome?: string;
    };
    expect(outcomeEvidence.is_validation).toBe(true);
    expect(outcomeEvidence.outcome).toBe('failed');
    const rollbackEvidence = JSON.parse(rollbackRow!.evidence) as {
      is_rollback?: boolean;
      rollback_details?: { config_key?: string };
    };
    expect(rollbackEvidence.is_rollback).toBe(true);
    expect(rollbackEvidence.rollback_details?.config_key).toBe(CONTENT_CADENCE_CONFIG_KEY);

    // Knob was removed by rollback — runtime_config_overrides is empty
    // and the cache reverts to the default constant.
    const afterRollback = env.rawDb
      .prepare('SELECT COUNT(*) as n FROM runtime_config_overrides')
      .get() as { n: number };
    expect(afterRollback.n).toBe(0);
    expect(currentContentCadence()).toBe(CONTENT_CADENCE_DEFAULT);
  });

  it('workspace guard: mismatched slug skips probe end-to-end without touching the knob', async () => {
    seedGoal(env.rawDb, { targetValue: 14, currentValue: 0, daysAhead: 7 });
    const guardedRunner = new ExperimentRunner(
      env.db,
      {} as unknown as RuntimeEngine,
      WORKSPACE_ID,
      'customer-7',
      { tickIntervalMs: 60_000, now: () => currentTime },
    );
    guardedRunner.register(new TestTuner());

    await guardedRunner.tick();

    // The probe returns a skipped result → judge=pass → no intervene
    // → no runtime_config write, no pending validation.
    const finding = env.rawDb
      .prepare("SELECT verdict, evidence FROM self_findings WHERE category = 'business_outcome'")
      .get() as { verdict: string; evidence: string };
    expect(finding.verdict).toBe('pass');
    const ev = JSON.parse(finding.evidence) as { skipped?: boolean; reason?: string };
    expect(ev.skipped).toBe(true);
    expect(ev.reason).toBe('workspace_guard');

    expect(
      env.rawDb.prepare('SELECT COUNT(*) as n FROM runtime_config_overrides').get(),
    ).toEqual({ n: 0 });
    expect(
      env.rawDb.prepare('SELECT COUNT(*) as n FROM experiment_validations').get(),
    ).toEqual({ n: 0 });
  });
});
