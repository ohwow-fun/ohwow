import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StaleTaskThresholdTunerExperiment } from '../experiments/stale-threshold-tuner.js';
import { STALE_THRESHOLD_CONFIG_KEY, currentStaleThresholdMs } from '../experiments/stale-task-cleanup.js';
import { _resetRuntimeConfigCacheForTests, setRuntimeConfig, getRuntimeConfig } from '../runtime-config.js';
import type { ExperimentContext, Finding, Verdict } from '../experiment-types.js';

const DEFAULT_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * DB stub supporting runtime_config_overrides for set/delete +
 * runtime_config_overrides for refresh. Also captures inserts so
 * tests can verify the tuner wrote to the right key.
 */
function buildDb() {
  const rows: Array<Record<string, unknown>> = [];
  function makeBuilder() {
    const filters: Array<{ col: string; val: unknown }> = [];
    const apply = () =>
      rows.filter((r) => filters.every((f) => r[f.col] === f.val));
    const builder: Record<string, unknown> = {};
    builder.select = () => ({
      then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
    });
    builder.eq = (col: string, val: unknown) => { filters.push({ col, val }); return builder; };
    builder.insert = (row: Record<string, unknown>) => {
      rows.push({ ...row });
      return Promise.resolve({ data: null, error: null });
    };
    builder.delete = () => ({
      eq: (col: string, val: unknown) => {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i][col] === val) rows.splice(i, 1);
        }
        return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) };
      },
    });
    return builder;
  }
  return {
    db: { from: vi.fn().mockImplementation(() => makeBuilder()) },
    rows,
  };
}

function makeCtx(
  env: ReturnType<typeof buildDb>,
  historyByExperiment: Record<string, Finding[]>,
): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: env.db as any,
    workspaceId: 'ws-1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async (experimentId) => historyByExperiment[experimentId] ?? [],
  };
}

function cleanupFinding(staleCount: number): Finding {
  return {
    id: 'f-' + Math.random().toString(36).slice(2),
    experimentId: 'stale-task-cleanup',
    category: 'other',
    subject: null,
    hypothesis: null,
    verdict: staleCount === 0 ? 'pass' : 'warning',
    summary: `${staleCount} stale`,
    evidence: { stale_count: staleCount },
    interventionApplied: staleCount > 0
      ? { description: 'swept', details: { cleaned_task_ids: [], affected_agent_ids: [] } }
      : null,
    ranAt: new Date().toISOString(),
    durationMs: 5,
    status: 'active',
    supersededBy: null,
    createdAt: new Date().toISOString(),
  };
}

describe('StaleTaskThresholdTunerExperiment — probe + judge', () => {
  const exp = new StaleTaskThresholdTunerExperiment();

  beforeEach(() => _resetRuntimeConfigCacheForTests());

  it('passes when avg stale_count is below the elevated threshold', async () => {
    const env = buildDb();
    const ctx = makeCtx(env, {
      'stale-task-cleanup': [
        cleanupFinding(0),
        cleanupFinding(1),
        cleanupFinding(0),
        cleanupFinding(1),
      ],
    });
    const result = await exp.probe(ctx);
    expect(exp.judge(result, [])).toBe('pass');
    const ev = result.evidence as { proposed_threshold_ms?: number };
    expect(ev.proposed_threshold_ms).toBeUndefined();
  });

  it('proposes a wider threshold when avg stale_count is elevated', async () => {
    const env = buildDb();
    const ctx = makeCtx(env, {
      'stale-task-cleanup': [
        cleanupFinding(3),
        cleanupFinding(3),
        cleanupFinding(2),
        cleanupFinding(3),
      ],
    });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { avg_stale_count: number; proposed_threshold_ms?: number; current_threshold_ms: number };
    expect(ev.avg_stale_count).toBeCloseTo(2.75);
    expect(ev.current_threshold_ms).toBe(DEFAULT_THRESHOLD_MS);
    expect(ev.proposed_threshold_ms).toBe(Math.round(DEFAULT_THRESHOLD_MS * 1.5));
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('does NOT propose when the last own finding was a rollback', async () => {
    const env = buildDb();
    const rollbackOwn: Finding = {
      id: 'own-1',
      experimentId: 'stale-threshold-tuner',
      category: 'validation',
      subject: 'rollback:earlier-intervention',
      hypothesis: null,
      verdict: 'warning',
      summary: 'rolled back',
      evidence: { is_rollback: true },
      interventionApplied: { description: 'reverted', details: {} },
      ranAt: new Date().toISOString(),
      durationMs: 5,
      status: 'active',
      supersededBy: null,
      createdAt: new Date().toISOString(),
    };
    const ctx = makeCtx(env, {
      'stale-task-cleanup': [cleanupFinding(4), cleanupFinding(4), cleanupFinding(4)],
      'stale-threshold-tuner': [rollbackOwn],
    });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { proposed_threshold_ms?: number; last_rollback_was_this_experiment?: boolean };
    expect(ev.last_rollback_was_this_experiment).toBe(true);
    expect(ev.proposed_threshold_ms).toBeUndefined();
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('uses the runtime-config current threshold as the baseline for the proposal', async () => {
    const env = buildDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await setRuntimeConfig(env.db as any, STALE_THRESHOLD_CONFIG_KEY, 20 * 60 * 1000);
    const ctx = makeCtx(env, {
      'stale-task-cleanup': [cleanupFinding(3), cleanupFinding(3), cleanupFinding(3)],
    });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { current_threshold_ms: number; proposed_threshold_ms?: number };
    expect(ev.current_threshold_ms).toBe(20 * 60 * 1000);
    expect(ev.proposed_threshold_ms).toBe(Math.round(20 * 60 * 1000 * 1.5));
  });
});

describe('StaleTaskThresholdTunerExperiment — intervene + rollback', () => {
  const exp = new StaleTaskThresholdTunerExperiment();

  beforeEach(() => _resetRuntimeConfigCacheForTests());

  it('intervene writes to runtime_config_overrides and updates the cache', async () => {
    const env = buildDb();
    const ctx = makeCtx(env, {
      'stale-task-cleanup': [cleanupFinding(3), cleanupFinding(3), cleanupFinding(3)],
    });
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('warning' as Verdict, result, ctx);
    expect(intervention).not.toBeNull();
    expect(intervention!.details.config_key).toBe(STALE_THRESHOLD_CONFIG_KEY);
    expect(intervention!.details.old_value_ms).toBe(DEFAULT_THRESHOLD_MS);
    expect(intervention!.details.new_value_ms).toBe(Math.round(DEFAULT_THRESHOLD_MS * 1.5));
    // Cache reflects the new value.
    expect(currentStaleThresholdMs()).toBe(Math.round(DEFAULT_THRESHOLD_MS * 1.5));
  });

  it('intervene returns null when probe did not propose', async () => {
    const env = buildDb();
    const ctx = makeCtx(env, {
      'stale-task-cleanup': [cleanupFinding(0), cleanupFinding(1), cleanupFinding(0)],
    });
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('pass' as Verdict, result, ctx);
    expect(intervention).toBeNull();
  });

  it('rollback removes the override and reverts to the const default', async () => {
    const env = buildDb();
    const ctx = makeCtx(env, {
      'stale-task-cleanup': [cleanupFinding(3), cleanupFinding(3), cleanupFinding(3)],
    });
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('warning' as Verdict, result, ctx);
    expect(currentStaleThresholdMs()).toBe(Math.round(DEFAULT_THRESHOLD_MS * 1.5));

    // Rollback receives the same baseline that validate would.
    const rollbackResult = await exp.rollback!(intervention!.details, ctx);
    expect(rollbackResult).not.toBeNull();
    expect(currentStaleThresholdMs()).toBe(DEFAULT_THRESHOLD_MS);
    // The rollback finding includes the reverted value for audit.
    expect(rollbackResult!.details.reverted_from_ms).toBe(Math.round(DEFAULT_THRESHOLD_MS * 1.5));
  });
});

describe('StaleTaskThresholdTunerExperiment — validate', () => {
  const exp = new StaleTaskThresholdTunerExperiment();

  beforeEach(() => _resetRuntimeConfigCacheForTests());

  const baseline = {
    config_key: STALE_THRESHOLD_CONFIG_KEY,
    old_value_ms: DEFAULT_THRESHOLD_MS,
    new_value_ms: Math.round(DEFAULT_THRESHOLD_MS * 1.5),
    trigger_avg_stale_count: 3.0,
  };

  it('returns held when post-change avg stale_count is lower than trigger', async () => {
    const env = buildDb();
    const ctx = makeCtx(env, {
      'stale-task-cleanup': [
        cleanupFinding(1),
        cleanupFinding(0),
        cleanupFinding(1),
      ],
    });
    const result = await exp.validate!(baseline, ctx);
    expect(result.outcome).toBe('held');
    expect(result.summary).toContain('widening helped');
    expect(result.evidence.post_change_avg_stale_count).toBeCloseTo(0.67, 1);
  });

  it('returns failed when post-change avg stale_count is equal or worse', async () => {
    const env = buildDb();
    const ctx = makeCtx(env, {
      'stale-task-cleanup': [
        cleanupFinding(4),
        cleanupFinding(5),
        cleanupFinding(3),
      ],
    });
    const result = await exp.validate!(baseline, ctx);
    expect(result.outcome).toBe('failed');
    expect(result.summary).toContain('did not help');
  });

  it('returns inconclusive when fewer than MIN_VALIDATION_SAMPLES findings', async () => {
    const env = buildDb();
    const ctx = makeCtx(env, {
      'stale-task-cleanup': [cleanupFinding(0)],
    });
    const result = await exp.validate!(baseline, ctx);
    expect(result.outcome).toBe('inconclusive');
    expect(result.summary).toContain('need');
  });
});
