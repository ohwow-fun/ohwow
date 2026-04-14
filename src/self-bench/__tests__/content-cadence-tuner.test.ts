/**
 * Tests for BusinessExperiment (via ContentCadenceTunerExperiment)
 * and the tuner's own probe/judge/intervene/validate/rollback logic.
 *
 * The DB stub is modeled on the stale-threshold-tuner test helper —
 * a minimal multi-table in-memory store supporting from().select()
 * with chained .eq() filters, from().insert(), and from().delete().
 * Keeps tests hermetic with no real SQLite dependency.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ContentCadenceTunerExperiment,
  CONTENT_CADENCE_CONFIG_KEY,
  CONTENT_CADENCE_DEFAULT,
  CONTENT_CADENCE_MAX,
  CONTENT_CADENCE_GOAL_METRIC,
  currentContentCadence,
} from '../experiments/content-cadence-tuner.js';
import {
  _resetRuntimeConfigCacheForTests,
  setRuntimeConfig,
} from '../runtime-config.js';
import type { ExperimentContext, Finding } from '../experiment-types.js';

interface GoalRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  title: string;
  target_metric: string | null;
  target_value: number | null;
  current_value: number | null;
  unit: string | null;
  due_date: string | null;
  status: string;
}

function buildDb() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    agent_workforce_goals: [],
    runtime_config_overrides: [],
  };

  function makeBuilder(tableName: string) {
    const filters: Array<{ col: string; val: unknown }> = [];
    const rows = () => (tables[tableName] ??= []);
    const apply = () =>
      rows().filter((r) => filters.every((f) => r[f.col] === f.val));
    const builder: Record<string, unknown> = {};
    // Thenable builder pattern: select/eq all return the same builder,
    // and `then` resolves with the filtered rows. Matches how the real
    // DatabaseAdapter's fluent query builder behaves end-to-end.
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => {
      filters.push({ col, val });
      return builder;
    };
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: apply(), error: null });
    builder.insert = (row: Record<string, unknown>) => {
      rows().push({ ...row });
      return Promise.resolve({ data: null, error: null });
    };
    builder.delete = () => ({
      eq: (col: string, val: unknown) => {
        const arr = rows();
        for (let i = arr.length - 1; i >= 0; i--) {
          if (arr[i][col] === val) arr.splice(i, 1);
        }
        return {
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: null, error: null }),
        };
      },
    });
    return builder;
  }

  return {
    db: { from: vi.fn().mockImplementation((name: string) => makeBuilder(name)) },
    tables,
  };
}

function makeCtx(
  env: ReturnType<typeof buildDb>,
  opts: {
    workspaceId?: string;
    workspaceSlug?: string;
    historyByExperiment?: Record<string, Finding[]>;
  } = {},
): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: env.db as any,
    // Row id used for SQL scoping. In prod this is the consolidated
    // cloud UUID or 'local' sentinel; in tests we just use 'default'
    // so the seeded goal rows (which also carry workspace_id='default')
    // match the SQL filter inside findActiveGoalByMetric.
    workspaceId: opts.workspaceId ?? 'default',
    // Human-readable slug the BusinessExperiment guard matches on.
    // Defaults to 'default' so unguarded tests match the
    // BusinessExperiment's allowedWorkspace default.
    workspaceSlug: opts.workspaceSlug ?? 'default',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async (experimentId) =>
      opts.historyByExperiment?.[experimentId] ?? [],
  };
}

function seedGoal(
  env: ReturnType<typeof buildDb>,
  partial: Partial<GoalRow> = {},
): GoalRow {
  const goal: GoalRow = {
    id: partial.id ?? 'goal-1',
    workspace_id: partial.workspace_id ?? 'default',
    title: partial.title ?? 'Ship 7 posts this week',
    target_metric: partial.target_metric ?? CONTENT_CADENCE_GOAL_METRIC,
    target_value: partial.target_value ?? 7,
    current_value: partial.current_value ?? 0,
    unit: partial.unit ?? 'posts',
    due_date:
      'due_date' in partial
        ? partial.due_date ?? null
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    status: partial.status ?? 'active',
  };
  (env.tables.agent_workforce_goals ??= []).push(goal);
  return goal;
}

function tunerFinding(opts: { ranAt: string; hasIntervention: boolean }): Finding {
  return {
    id: 'f-' + Math.random().toString(36).slice(2),
    experimentId: 'content-cadence-tuner',
    category: 'business_outcome',
    subject: 'goal:goal-1',
    hypothesis: null,
    verdict: opts.hasIntervention ? 'warning' : 'pass',
    summary: 'test',
    evidence: {},
    interventionApplied: opts.hasIntervention
      ? { description: 'widened', details: { config_key: CONTENT_CADENCE_CONFIG_KEY } }
      : null,
    ranAt: opts.ranAt,
    durationMs: 1,
    status: 'active',
    supersededBy: null,
    createdAt: opts.ranAt,
  };
}

beforeEach(() => {
  _resetRuntimeConfigCacheForTests();
});

describe('BusinessExperiment — workspace guard (via ContentCadenceTunerExperiment)', () => {
  it('skips probe when workspaceSlug does not match allowedWorkspace', async () => {
    const env = buildDb();
    seedGoal(env);
    // Simulate a customer workspace: different slug, whatever row id.
    const ctx = makeCtx(env, {
      workspaceId: 'cloud-uuid-whatever',
      workspaceSlug: 'customer-7',
    });
    const exp = new ContentCadenceTunerExperiment();

    const result = await exp.probe(ctx);
    expect((result.evidence as { skipped?: boolean }).skipped).toBe(true);
    expect((result.evidence as { reason?: string }).reason).toBe('workspace_guard');
    expect((result.evidence as { actual_workspace?: string }).actual_workspace).toBe('customer-7');
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('does NOT skip when workspaceId looks wrong but workspaceSlug matches', async () => {
    const env = buildDb();
    // Production shape: workspaceId is the consolidated cloud UUID
    // (or 'local' sentinel), NOT the human-readable slug. The SQL
    // scoping filter matches on workspaceId, so we seed the goal with
    // the same UUID; the BusinessExperiment guard separately matches
    // on workspaceSlug, so the UUID row id shouldn't open or close it.
    const cloudUuid = '11111111-2222-3333-4444-555555555555';
    seedGoal(env, {
      workspace_id: cloudUuid,
      current_value: 0,
      target_value: 7,
    });
    const ctx = makeCtx(env, {
      workspaceId: cloudUuid,
      workspaceSlug: 'default',
    });
    const exp = new ContentCadenceTunerExperiment();

    const result = await exp.probe(ctx);
    expect((result.evidence as { skipped?: boolean }).skipped).not.toBe(true);
    expect((result.evidence as { goal_id?: string }).goal_id).toBe('goal-1');
  });

  it('intervene returns null on a skipped probe', async () => {
    const env = buildDb();
    const ctx = makeCtx(env, { workspaceSlug: 'customer-7' });
    const exp = new ContentCadenceTunerExperiment();

    const result = await exp.probe(ctx);
    const intervention = await exp.intervene('pass', result, ctx);
    expect(intervention).toBeNull();
  });

  it('falls back to OHWOW_WORKSPACE env var when workspaceSlug is absent', async () => {
    const env = buildDb();
    seedGoal(env, { current_value: 0, target_value: 7 });
    const prior = process.env.OHWOW_WORKSPACE;
    try {
      process.env.OHWOW_WORKSPACE = 'avenued';
      // No workspaceSlug in the context.
      const ctx: ExperimentContext = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: env.db as any,
        workspaceId: 'row-id',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        engine: {} as any,
        recentFindings: async () => [],
      };
      const exp = new ContentCadenceTunerExperiment();
      const result = await exp.probe(ctx);
      // env says 'avenued', experiment defaults to 'default' → skip.
      expect((result.evidence as { skipped?: boolean }).skipped).toBe(true);
      expect((result.evidence as { actual_workspace?: string }).actual_workspace).toBe('avenued');
    } finally {
      if (prior === undefined) delete process.env.OHWOW_WORKSPACE;
      else process.env.OHWOW_WORKSPACE = prior;
    }
  });
});

describe('ContentCadenceTunerExperiment — probe + judge', () => {
  it('passes with reason=no_goal when no matching goal exists', async () => {
    const env = buildDb();
    const ctx = makeCtx(env);
    const exp = new ContentCadenceTunerExperiment();

    const result = await exp.probe(ctx);
    expect((result.evidence as { reason?: string }).reason).toBe('no_goal');
    expect((result.evidence as { current_cadence?: number }).current_cadence).toBe(
      CONTENT_CADENCE_DEFAULT,
    );
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('passes when the goal has no due_date (not tunable)', async () => {
    const env = buildDb();
    seedGoal(env, { due_date: null });
    const ctx = makeCtx(env);
    const exp = new ContentCadenceTunerExperiment();

    const result = await exp.probe(ctx);
    expect((result.evidence as { reason?: string }).reason).toBe('goal_missing_due_date');
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('passes when the goal is already met', async () => {
    const env = buildDb();
    seedGoal(env, { current_value: 7, target_value: 7 });
    const ctx = makeCtx(env);
    const exp = new ContentCadenceTunerExperiment();

    const result = await exp.probe(ctx);
    expect((result.evidence as { reason?: string }).reason).toBe('goal_met_or_past_due');
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('emits warning when goal is behind required velocity', async () => {
    const env = buildDb();
    // 7 posts, due in 7 days, current 0 → required 1/day. Default knob
    // is 1, so proposal = max(1, ceil(1)) = 1. NOT behind — equal.
    // Make it actually behind: 14 target, due in 7 days → required 2/day.
    seedGoal(env, { current_value: 0, target_value: 14 });
    const ctx = makeCtx(env);
    const exp = new ContentCadenceTunerExperiment();

    const result = await exp.probe(ctx);
    const ev = result.evidence as { should_widen?: boolean; proposed_cadence?: number };
    expect(ev.should_widen).toBe(true);
    expect(ev.proposed_cadence).toBe(2);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('caps proposed_cadence at CONTENT_CADENCE_MAX', async () => {
    const env = buildDb();
    // 100 posts due in 1 day → required 100/day. Should cap at 5.
    seedGoal(env, {
      current_value: 0,
      target_value: 100,
      due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    const ctx = makeCtx(env);
    const exp = new ContentCadenceTunerExperiment();

    const result = await exp.probe(ctx);
    const ev = result.evidence as { proposed_cadence?: number };
    expect(ev.proposed_cadence).toBe(CONTENT_CADENCE_MAX);
  });

  it('passes without widening when knob already meets required velocity', async () => {
    const env = buildDb();
    seedGoal(env, { current_value: 0, target_value: 7 });
    const ctx = makeCtx(env);
    const exp = new ContentCadenceTunerExperiment();
    // Knob already at 3 — covers required 1/day comfortably.
    await setRuntimeConfig(env.db as never, CONTENT_CADENCE_CONFIG_KEY, 3);

    const result = await exp.probe(ctx);
    const ev = result.evidence as { should_widen?: boolean; current_cadence?: number };
    expect(ev.current_cadence).toBe(3);
    expect(ev.should_widen).toBe(false);
    expect(exp.judge(result, [])).toBe('pass');
  });
});

describe('ContentCadenceTunerExperiment — intervene', () => {
  it('writes runtime_config and returns InterventionApplied on warning', async () => {
    const env = buildDb();
    seedGoal(env, { current_value: 0, target_value: 14 }); // required 2/day
    const ctx = makeCtx(env);
    const exp = new ContentCadenceTunerExperiment();

    const result = await exp.probe(ctx);
    const intervention = await exp.intervene('warning', result, ctx);

    expect(intervention).not.toBeNull();
    expect(intervention!.description).toContain('1 to 2');
    expect(intervention!.details.config_key).toBe(CONTENT_CADENCE_CONFIG_KEY);
    expect(intervention!.details.new_value).toBe(2);
    expect(intervention!.details.reversible).toBe(true);
    expect(currentContentCadence()).toBe(2);
  });

  it('returns null when the daily intervention cap is already reached', async () => {
    const env = buildDb();
    seedGoal(env, { current_value: 0, target_value: 14 });
    const now = Date.now();
    const ctx = makeCtx(env, {
      historyByExperiment: {
        'content-cadence-tuner': [
          // One intervention 6 hours ago is enough to hit the cap (cap=1).
          tunerFinding({
            ranAt: new Date(now - 6 * 60 * 60 * 1000).toISOString(),
            hasIntervention: true,
          }),
        ],
      },
    });
    const exp = new ContentCadenceTunerExperiment();

    const result = await exp.probe(ctx);
    const intervention = await exp.intervene('warning', result, ctx);
    expect(intervention).toBeNull();
    // And the runtime_config stayed at the default — we bailed before setRuntimeConfig.
    expect(currentContentCadence()).toBe(CONTENT_CADENCE_DEFAULT);
  });

  it('allows another intervention when the prior one is outside the cap window', async () => {
    const env = buildDb();
    seedGoal(env, { current_value: 0, target_value: 14 });
    const now = Date.now();
    const ctx = makeCtx(env, {
      historyByExperiment: {
        'content-cadence-tuner': [
          tunerFinding({
            ranAt: new Date(now - 36 * 60 * 60 * 1000).toISOString(), // >24h ago
            hasIntervention: true,
          }),
        ],
      },
    });
    const exp = new ContentCadenceTunerExperiment();

    const result = await exp.probe(ctx);
    const intervention = await exp.intervene('warning', result, ctx);
    expect(intervention).not.toBeNull();
  });
});

describe('ContentCadenceTunerExperiment — validate + rollback', () => {
  it("validates 'held' when goal current_value moved by >= delta floor", async () => {
    const env = buildDb();
    // Required 2/day, baseline goal was 0. After widen, goal moved to 2.
    // Floor = 2 * 0.5 = 1. Delta = 2 >= 1 → held.
    seedGoal(env, { current_value: 2 });
    const ctx = makeCtx(env);
    const exp = new ContentCadenceTunerExperiment();

    const result = await exp.validate(
      {
        goal_id: 'goal-1',
        old_value: 1,
        new_value: 2,
        goal_current_value_at_intervention: 0,
        required_per_day: 2,
      },
      ctx,
    );
    expect(result.outcome).toBe('held');
  });

  it("validates 'failed' when goal delta is below floor", async () => {
    const env = buildDb();
    // Required 2/day, baseline 0. Goal only moved to 0.5. Floor = 1. Delta 0.5 < 1 → failed.
    seedGoal(env, { current_value: 0.5 });
    const ctx = makeCtx(env);
    const exp = new ContentCadenceTunerExperiment();

    const result = await exp.validate(
      {
        goal_id: 'goal-1',
        old_value: 1,
        new_value: 2,
        goal_current_value_at_intervention: 0,
        required_per_day: 2,
      },
      ctx,
    );
    expect(result.outcome).toBe('failed');
  });

  it("validates 'inconclusive' when goal no longer exists", async () => {
    const env = buildDb();
    const ctx = makeCtx(env);
    const exp = new ContentCadenceTunerExperiment();

    const result = await exp.validate(
      {
        goal_id: 'nonexistent',
        goal_current_value_at_intervention: 0,
        required_per_day: 2,
      },
      ctx,
    );
    expect(result.outcome).toBe('inconclusive');
  });

  it('rollback removes the runtime_config override', async () => {
    const env = buildDb();
    const ctx = makeCtx(env);
    const exp = new ContentCadenceTunerExperiment();
    await setRuntimeConfig(env.db as never, CONTENT_CADENCE_CONFIG_KEY, 3);
    expect(currentContentCadence()).toBe(3);

    const intervention = await exp.rollback(
      { old_value: 1, new_value: 3 },
      ctx,
    );
    expect(intervention).not.toBeNull();
    expect(intervention!.description).toContain('reverted');
    expect(currentContentCadence()).toBe(CONTENT_CADENCE_DEFAULT);
  });
});
