import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  XShapeTunerExperiment,
  proposeWeights,
  SHAPE_WEIGHTS_CONFIG_KEY,
  SHAPE_WEIGHTS_SIDECAR_NAME,
  CANONICAL_SHAPES,
} from '../experiments/x-shape-tuner.js';
import {
  _resetRuntimeConfigCacheForTests,
  _seedRuntimeConfigCacheForTests,
  getRuntimeConfigCacheSnapshot,
} from '../runtime-config.js';
import type { ExperimentContext, Finding } from '../experiment-types.js';

let tempDir: string;

function defaultWeights(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of CANONICAL_SHAPES) out[s] = 1;
  return out;
}

function makeCtx(observerFindings: Finding[]): ExperimentContext {
  const inserts: Array<Record<string, unknown>> = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {
      from: () => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.order = () => chain;
        chain.limit = () => Promise.resolve({ data: [], error: null });
        chain.delete = () => chain;
        chain.insert = (row: Record<string, unknown>) => {
          inserts.push(row);
          return Promise.resolve({ data: null, error: null });
        };
        chain.then = (resolve: (v: unknown) => void) =>
          resolve({ data: [], error: null });
        return chain;
      },
    } as any,
    workspaceId: 'ws-test',
    workspaceSlug: 'default',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async (id: string, _limit?: number) =>
      id === 'x-ops-observer' ? observerFindings : [],
  };
}

function observerFinding(overrides: Partial<{
  shape_distribution: Record<string, number>;
  dispatch_success_rate: number | null;
  engagement_median_likes: number | null;
  approvals_counted: number;
}>): Finding {
  return {
    id: 'f-obs-' + Math.random().toString(36).slice(2, 10),
    experimentId: 'x-ops-observer',
    category: 'business_outcome',
    subject: 'x-ops:summary',
    hypothesis: null,
    verdict: 'warning',
    summary: 'obs',
    evidence: {
      shape_distribution: {},
      dispatch_success_rate: 0.95,
      engagement_median_likes: 50,
      approvals_counted: 20,
      ...overrides,
    },
    interventionApplied: null,
    ranAt: new Date().toISOString(),
    durationMs: 0,
    status: 'active',
    supersededBy: null,
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-shape-tuner-'));
  _resetRuntimeConfigCacheForTests();
});

afterEach(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  _resetRuntimeConfigCacheForTests();
});

describe('proposeWeights', () => {
  it('returns null when total volume is below threshold', () => {
    const result = proposeWeights(
      defaultWeights(),
      { humor: 3, tactical_tip: 2 },
      0.95,
    );
    expect(result).toBeNull();
  });

  it('shrinks the over-represented shape when dispatch is sub-90%', () => {
    // humor = 60% of 20 compose posts, dispatch 0.8 → shrink humor
    const result = proposeWeights(
      defaultWeights(),
      { humor: 12, tactical_tip: 5, observation: 3 },
      0.8,
    );
    expect(result).not.toBeNull();
    expect(result!.weights.humor).toBeLessThan(1);
    expect(result!.reason).toContain('shrink-humor');
  });

  it('widens the under-represented shape even when dispatch is fine', () => {
    // humor=60%, question=1 (5%). Dispatch high → no shrink, but widen question.
    const result = proposeWeights(
      defaultWeights(),
      { humor: 12, tactical_tip: 5, observation: 2, question: 1 },
      0.95,
    );
    expect(result).not.toBeNull();
    expect(result!.weights.question).toBeGreaterThan(1);
    expect(result!.reason).toContain('widen-question');
  });

  it('never exceeds cumulative delta 0.5 across both shrink + widen', () => {
    const result = proposeWeights(
      defaultWeights(),
      { humor: 15, tactical_tip: 3, observation: 1, question: 1 },
      0.8,
    );
    expect(result).not.toBeNull();
    const baseline = defaultWeights();
    let totalDelta = 0;
    for (const shape of CANONICAL_SHAPES) {
      totalDelta += Math.abs(result!.weights[shape] - baseline[shape]);
    }
    expect(totalDelta).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('returns null when distribution is balanced and dispatch is healthy', () => {
    const result = proposeWeights(
      defaultWeights(),
      { humor: 4, tactical_tip: 4, observation: 4, question: 4, opinion: 4 },
      0.95,
    );
    expect(result).toBeNull();
  });
});

describe('XShapeTunerExperiment', () => {
  it('stands down when no observer findings exist', async () => {
    const exp = new XShapeTunerExperiment(tempDir);
    const ctx = makeCtx([]);
    const result = await (exp as any).businessProbe(ctx);
    expect((result.evidence as any).observer_stale).toBe(true);
    expect((exp as any).businessJudge(result, [])).toBe('pass');
  });

  it('proposes a reweight when observer reports overrep + low dispatch', async () => {
    const exp = new XShapeTunerExperiment(tempDir);
    const ctx = makeCtx([
      observerFinding({
        shape_distribution: { humor: 12, tactical_tip: 5, observation: 3 },
        dispatch_success_rate: 0.8,
        approvals_counted: 20,
      }),
    ]);
    const result = await (exp as any).businessProbe(ctx);
    expect((result.evidence as any).should_tune).toBe(true);
    expect((exp as any).businessJudge(result, [])).toBe('warning');
  });

  it('intervene writes runtime_config and sidecar JSON', async () => {
    const exp = new XShapeTunerExperiment(tempDir);
    const ctx = makeCtx([
      observerFinding({
        shape_distribution: { humor: 12, tactical_tip: 5, observation: 3 },
        dispatch_success_rate: 0.8,
        approvals_counted: 20,
      }),
    ]);
    const result = await (exp as any).businessProbe(ctx);
    const intervention = await (exp as any).businessIntervene('warning', result, ctx);
    expect(intervention).not.toBeNull();
    expect(intervention.details.config_key).toBe(SHAPE_WEIGHTS_CONFIG_KEY);

    const snap = getRuntimeConfigCacheSnapshot();
    const entry = snap.find((e) => e.key === SHAPE_WEIGHTS_CONFIG_KEY);
    expect(entry).toBeDefined();

    const sidecar = path.join(tempDir, SHAPE_WEIGHTS_SIDECAR_NAME);
    expect(fs.existsSync(sidecar)).toBe(true);
    const contents = JSON.parse(fs.readFileSync(sidecar, 'utf-8'));
    expect(contents.weights).toBeDefined();
    expect(contents.updated_by).toBe('x-shape-tuner');
  });

  it('rollback clears runtime_config and unlinks the sidecar', async () => {
    const exp = new XShapeTunerExperiment(tempDir);
    // Seed an already-applied intervention state: cache + sidecar.
    _seedRuntimeConfigCacheForTests(SHAPE_WEIGHTS_CONFIG_KEY, { humor: 0.8 });
    const sidecar = path.join(tempDir, SHAPE_WEIGHTS_SIDECAR_NAME);
    fs.writeFileSync(sidecar, JSON.stringify({ weights: { humor: 0.8 }, updated_by: 'x-shape-tuner' }));

    const ctx = makeCtx([]);
    const result = await (exp as any).rollback(
      { baseline_weights: defaultWeights() },
      ctx,
    );
    expect(result).not.toBeNull();
    expect(fs.existsSync(sidecar)).toBe(false);
  });

  it('validate marks regression as failed when dispatch or likes drop', async () => {
    const exp = new XShapeTunerExperiment(tempDir);
    const ctx = makeCtx([
      observerFinding({ dispatch_success_rate: 0.6, engagement_median_likes: 20, approvals_counted: 20 }),
    ]);
    const baseline = {
      dispatch_success_rate_at_intervention: 0.9,
      engagement_median_likes_at_intervention: 40,
      baseline_weights: defaultWeights(),
    };
    const validation = await exp.validate(baseline, ctx);
    expect(validation.outcome).toBe('failed');
  });

  it('validate marks held when post-metrics are comparable to baseline', async () => {
    const exp = new XShapeTunerExperiment(tempDir);
    const ctx = makeCtx([
      observerFinding({ dispatch_success_rate: 0.92, engagement_median_likes: 45, approvals_counted: 20 }),
    ]);
    const baseline = {
      dispatch_success_rate_at_intervention: 0.9,
      engagement_median_likes_at_intervention: 40,
      baseline_weights: defaultWeights(),
    };
    const validation = await exp.validate(baseline, ctx);
    expect(validation.outcome).toBe('held');
  });
});
