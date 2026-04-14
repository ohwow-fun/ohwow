/**
 * Tests for ContentCadenceLoopHealthExperiment. The probe's job is to
 * read multiple tables (goals, tasks, runtime_config_overrides,
 * experiment_validations) and the tuner's recent findings, then judge
 * whether the closed loop has completed a recent cycle. The hardest
 * thing to verify is that each broken vital sign maps to the expected
 * verdict — these tests pin every transition.
 *
 * Uses a multi-table in-memory stub with select+filter+chained .eq, the
 * same shape as the existing tuner unit tests. Keeps tests hermetic
 * with no real SQLite dependency.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContentCadenceLoopHealthExperiment } from '../experiments/content-cadence-loop-health.js';
import { CONTENT_CADENCE_CONFIG_KEY, CONTENT_CADENCE_GOAL_METRIC } from '../experiments/content-cadence-tuner.js';
import type { ExperimentContext, Finding } from '../experiment-types.js';

interface GoalRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  target_metric: string;
  status: string;
  current_value: number;
  target_value: number;
  created_at: string;
  updated_at: string;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  title: string | null;
  status: string;
  metadata: string | null;
  created_at: string | null;
  completed_at: string | null;
}

interface OverrideRow extends Record<string, unknown> {
  key: string;
  value: string;
  set_at: string;
}

interface ValidationRow extends Record<string, unknown> {
  id: string;
  experiment_id: string;
  status: string;
  validate_at: string;
  created_at: string;
}

function buildDb() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    agent_workforce_goals: [],
    agent_workforce_tasks: [],
    runtime_config_overrides: [],
    experiment_validations: [],
  };

  function makeBuilder(tableName: string) {
    const filters: Array<{ col: string; val: unknown }> = [];
    const rows = () => (tables[tableName] ??= []);
    const apply = () =>
      rows().filter((r) => filters.every((f) => r[f.col] === f.val));
    const builder: Record<string, unknown> = {};
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
    workspaceSlug?: string;
    tunerHistory?: Finding[];
  } = {},
): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: env.db as any,
    workspaceId: 'ws-1',
    workspaceSlug: opts.workspaceSlug ?? 'default',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async (experimentId) =>
      experimentId === 'content-cadence-tuner' ? (opts.tunerHistory ?? []) : [],
  };
}

function seedGoal(
  env: ReturnType<typeof buildDb>,
  opts: { ageHours?: number; updatedHoursAgo?: number } = {},
) {
  const now = Date.now();
  const goal: GoalRow = {
    id: 'goal-x-posts-per-week',
    workspace_id: 'ws-1',
    target_metric: CONTENT_CADENCE_GOAL_METRIC,
    status: 'active',
    current_value: 2,
    target_value: 7,
    created_at: new Date(now - (opts.ageHours ?? 48) * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(now - (opts.updatedHoursAgo ?? 0.5) * 60 * 60 * 1000).toISOString(),
  };
  (env.tables.agent_workforce_goals ??= []).push(goal);
  return goal;
}

function seedTask(
  env: ReturnType<typeof buildDb>,
  opts: {
    title?: string;
    status?: string;
    createdHoursAgo?: number;
    completedHoursAgo?: number | null;
    postedVia?: string | null;
  },
) {
  const now = Date.now();
  const created = new Date(now - (opts.createdHoursAgo ?? 1) * 60 * 60 * 1000).toISOString();
  const completed =
    opts.completedHoursAgo === null
      ? null
      : new Date(now - (opts.completedHoursAgo ?? 0.5) * 60 * 60 * 1000).toISOString();
  const meta = opts.postedVia
    ? JSON.stringify({ posted_via: opts.postedVia })
    : null;
  (env.tables.agent_workforce_tasks ??= []).push({
    id: `t-${Math.random().toString(36).slice(2)}`,
    workspace_id: 'ws-1',
    title: opts.title ?? null,
    status: opts.status ?? 'completed',
    metadata: meta,
    created_at: created,
    completed_at: completed,
  } as TaskRow);
}

function seedKnob(env: ReturnType<typeof buildDb>, value: number) {
  (env.tables.runtime_config_overrides ??= []).push({
    key: CONTENT_CADENCE_CONFIG_KEY,
    value: JSON.stringify(value),
    set_at: new Date().toISOString(),
  } as OverrideRow);
}

function seedValidation(env: ReturnType<typeof buildDb>, status: 'pending' | 'completed') {
  (env.tables.experiment_validations ??= []).push({
    id: `v-${Math.random().toString(36).slice(2)}`,
    experiment_id: 'content-cadence-tuner',
    status,
    validate_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: new Date().toISOString(),
  } as ValidationRow);
}

function tunerFinding(opts: {
  hoursAgo?: number;
  hasIntervention?: boolean;
}): Finding {
  const ranAt = new Date(Date.now() - (opts.hoursAgo ?? 1) * 60 * 60 * 1000).toISOString();
  return {
    id: `f-${Math.random().toString(36).slice(2)}`,
    experimentId: 'content-cadence-tuner',
    category: 'business_outcome',
    subject: 'goal:goal-x-posts-per-week',
    hypothesis: null,
    verdict: opts.hasIntervention ? 'warning' : 'pass',
    summary: 'tuner ran',
    evidence: {},
    interventionApplied: opts.hasIntervention
      ? { description: 'widened', details: { config_key: CONTENT_CADENCE_CONFIG_KEY } }
      : null,
    ranAt,
    durationMs: 1,
    status: 'active',
    supersededBy: null,
    createdAt: ranAt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ContentCadenceLoopHealthExperiment — early states', () => {
  it('passes with reason=no_goal_yet when the goal does not exist', async () => {
    const env = buildDb();
    const exp = new ContentCadenceLoopHealthExperiment();
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { reason?: string; goal_exists?: boolean };
    expect(ev.reason).toBe('no_goal_yet');
    expect(ev.goal_exists).toBe(false);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('passes with reason=warmup when the goal is younger than 24h', async () => {
    const env = buildDb();
    seedGoal(env, { ageHours: 6 });
    const exp = new ContentCadenceLoopHealthExperiment();
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { reason?: string };
    expect(ev.reason).toBe('warmup');
    expect(exp.judge(result, [])).toBe('pass');
  });
});

describe('ContentCadenceLoopHealthExperiment — vital signs', () => {
  it('passes when all vital signs are healthy', async () => {
    const env = buildDb();
    seedGoal(env, { ageHours: 48, updatedHoursAgo: 0.5 });
    seedTask(env, { title: 'Post one tweet today', status: 'completed', createdHoursAgo: 6, completedHoursAgo: 5, postedVia: 'x_compose_tweet' });
    const exp = new ContentCadenceLoopHealthExperiment();
    const result = await exp.probe(makeCtx(env, { tunerHistory: [tunerFinding({ hoursAgo: 2 })] }));
    const ev = result.evidence as { failures: string[]; vital_signs: Record<string, boolean> };
    expect(ev.failures).toHaveLength(0);
    expect(ev.vital_signs.scheduler_alive).toBe(true);
    expect(ev.vital_signs.dispatcher_active).toBe(true);
    expect(ev.vital_signs.posts_completing).toBe(true);
    expect(ev.vital_signs.tuner_alive).toBe(true);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('warns when scheduler_alive fails (goal stale > 2h)', async () => {
    const env = buildDb();
    seedGoal(env, { ageHours: 48, updatedHoursAgo: 3 });
    seedTask(env, { title: 'Post one tweet today', status: 'completed', createdHoursAgo: 6, completedHoursAgo: 5, postedVia: 'x_compose_tweet' });
    const exp = new ContentCadenceLoopHealthExperiment();
    const result = await exp.probe(makeCtx(env, { tunerHistory: [tunerFinding({ hoursAgo: 2 })] }));
    const ev = result.evidence as { failures: string[]; vital_signs: Record<string, boolean> };
    expect(ev.vital_signs.scheduler_alive).toBe(false);
    expect(ev.failures.some((f) => f.includes('scheduler stalled'))).toBe(true);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('fails when scheduler is dead > 6h (the dispatch-bug shape)', async () => {
    const env = buildDb();
    seedGoal(env, { ageHours: 48, updatedHoursAgo: 8 });
    const exp = new ContentCadenceLoopHealthExperiment();
    const result = await exp.probe(makeCtx(env));
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('warns when dispatcher_active fails (no dispatches AND no completions in 24h)', async () => {
    const env = buildDb();
    seedGoal(env, { ageHours: 48, updatedHoursAgo: 0.5 });
    // No post tasks at all.
    const exp = new ContentCadenceLoopHealthExperiment();
    const result = await exp.probe(makeCtx(env, { tunerHistory: [tunerFinding({ hoursAgo: 2 })] }));
    const ev = result.evidence as { vital_signs: Record<string, boolean>; failures: string[] };
    expect(ev.vital_signs.dispatcher_active).toBe(false);
    expect(ev.failures.some((f) => f.includes('dispatcher silent'))).toBe(true);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('warns when dispatched tasks do not complete (agents stalled)', async () => {
    const env = buildDb();
    seedGoal(env, { ageHours: 48, updatedHoursAgo: 0.5 });
    // Dispatched but never completed.
    seedTask(env, {
      title: 'Post one tweet today',
      status: 'pending',
      createdHoursAgo: 6,
      completedHoursAgo: null,
      postedVia: null,
    });
    const exp = new ContentCadenceLoopHealthExperiment();
    const result = await exp.probe(makeCtx(env, { tunerHistory: [tunerFinding({ hoursAgo: 2 })] }));
    const ev = result.evidence as { vital_signs: Record<string, boolean>; failures: string[] };
    expect(ev.vital_signs.posts_completing).toBe(false);
    expect(ev.failures.some((f) => f.includes('none completed'))).toBe(true);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('warns when tuner has emitted no findings in 24h', async () => {
    const env = buildDb();
    seedGoal(env, { ageHours: 48, updatedHoursAgo: 0.5 });
    seedTask(env, { title: 'Post one tweet today', status: 'completed', createdHoursAgo: 6, completedHoursAgo: 5, postedVia: 'x_compose_tweet' });
    // No tuner findings at all.
    const exp = new ContentCadenceLoopHealthExperiment();
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { vital_signs: Record<string, boolean>; failures: string[] };
    expect(ev.vital_signs.tuner_alive).toBe(false);
    expect(ev.failures.some((f) => f.includes('tuner silent'))).toBe(true);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('warns when knob is set but no validation row exists', async () => {
    const env = buildDb();
    seedGoal(env, { ageHours: 48, updatedHoursAgo: 0.5 });
    seedTask(env, { title: 'Post one tweet today', status: 'completed', createdHoursAgo: 6, completedHoursAgo: 5, postedVia: 'x_compose_tweet' });
    seedKnob(env, 2);
    // Tuner emitted an intervention but somehow no validation was enqueued.
    const exp = new ContentCadenceLoopHealthExperiment();
    const result = await exp.probe(
      makeCtx(env, { tunerHistory: [tunerFinding({ hoursAgo: 2, hasIntervention: true })] }),
    );
    const ev = result.evidence as { vital_signs: Record<string, boolean>; failures: string[] };
    expect(ev.vital_signs.validation_chain_intact).toBe(false);
    expect(ev.failures.some((f) => f.includes('no validation row'))).toBe(true);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('passes when knob is set AND a validation row exists for it', async () => {
    const env = buildDb();
    seedGoal(env, { ageHours: 48, updatedHoursAgo: 0.5 });
    seedTask(env, { title: 'Post one tweet today', status: 'completed', createdHoursAgo: 6, completedHoursAgo: 5, postedVia: 'x_compose_tweet' });
    seedKnob(env, 2);
    seedValidation(env, 'pending');
    const exp = new ContentCadenceLoopHealthExperiment();
    const result = await exp.probe(
      makeCtx(env, { tunerHistory: [tunerFinding({ hoursAgo: 2, hasIntervention: true })] }),
    );
    const ev = result.evidence as { vital_signs: Record<string, boolean>; failures: string[] };
    expect(ev.vital_signs.validation_chain_intact).toBe(true);
    expect(ev.failures).toHaveLength(0);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('fails when 3+ vital signs are broken', async () => {
    const env = buildDb();
    // Goal exists past warmup but stale. No tasks. No tuner findings. Knob set but no validation.
    seedGoal(env, { ageHours: 48, updatedHoursAgo: 3 });
    seedKnob(env, 2);
    const exp = new ContentCadenceLoopHealthExperiment();
    const result = await exp.probe(
      makeCtx(env, { tunerHistory: [tunerFinding({ hoursAgo: 30, hasIntervention: true })] }),
    );
    const ev = result.evidence as { failures: string[] };
    // scheduler_alive: false (stale 3h)
    // dispatcher_active: false (0 dispatches/24h)
    // posts_completing: true (no dispatches → trivially passes)
    // tuner_alive: false (last finding 30h ago)
    // validation_chain_intact: false (knob set but no validation; intervention from 30h ago is outside 24h window so trivially passes — wait)
    // Actually the validation_chain check is "if knob set AND interventions24h>0 AND no pending validations → fail". The intervention is 30h ago so interventions24h=0, so this trivially passes.
    // So failures = scheduler_alive, dispatcher_active, tuner_alive = 3 failures → fail
    expect(ev.failures.length).toBeGreaterThanOrEqual(3);
    expect(exp.judge(result, [])).toBe('fail');
  });
});

describe('ContentCadenceLoopHealthExperiment — workspace guard', () => {
  it('skips probe when workspaceSlug is not default', async () => {
    const env = buildDb();
    seedGoal(env, { ageHours: 48 });
    const exp = new ContentCadenceLoopHealthExperiment();
    const result = await exp.probe(makeCtx(env, { workspaceSlug: 'customer-7' }));
    const ev = result.evidence as { skipped?: boolean; reason?: string };
    expect(ev.skipped).toBe(true);
    expect(ev.reason).toBe('workspace_guard');
    expect(exp.judge(result, [])).toBe('pass');
  });
});
