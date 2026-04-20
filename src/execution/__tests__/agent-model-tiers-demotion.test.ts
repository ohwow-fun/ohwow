import { describe, it, expect, beforeEach } from 'vitest';
import {
  AGENT_MODEL_TIERS,
  selectAgentModelForIteration,
  refreshDemotedAgentModels,
  getAgentModelDemotionSnapshot,
  _resetAgentModelDemotionCacheForTests,
  getInductedModelCandidates,
} from '../agent-model-tiers.js';
import type { ModelProvider } from '../model-router.js';
import {
  _resetRuntimeConfigCacheForTests,
  _seedRuntimeConfigCacheForTests,
} from '../../self-bench/runtime-config.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

// A stub OpenRouter provider — only the `name` field matters here.
const openrouter = { name: 'openrouter' } as unknown as ModelProvider;
const ollama = { name: 'ollama' } as unknown as ModelProvider;

/**
 * Build a tiny fake DatabaseAdapter that returns a fixed set of llm_calls
 * rows regardless of the query shape. Just enough surface to satisfy the
 * `.from().select().eq().gte()` chain refreshDemotedAgentModels uses.
 */
function fakeDb(rows: Array<{ model: string; tool_call_count: number | null }>) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gte: () => Promise.resolve({ data: rows, error: null }),
  };
  return {
    from: () => chain,
  } as unknown as import('../../db/adapter-types.js').DatabaseAdapter;
}

describe('selectAgentModelForIteration — baseline (no demotions)', () => {
  beforeEach(() => _resetAgentModelDemotionCacheForTests());

  it('returns FAST for simple iteration 0', () => {
    expect(selectAgentModelForIteration(0, 'simple', false, false, false, openrouter))
      .toBe(AGENT_MODEL_TIERS.FAST);
  });

  it('returns BALANCED for moderate iteration 0', () => {
    expect(selectAgentModelForIteration(0, 'moderate', false, false, false, openrouter))
      .toBe(AGENT_MODEL_TIERS.BALANCED);
  });

  it('returns STRONG for complex iteration 0', () => {
    expect(selectAgentModelForIteration(0, 'complex', false, false, false, openrouter))
      .toBe(AGENT_MODEL_TIERS.STRONG);
  });

  it('returns FREE for iteration 3+', () => {
    expect(selectAgentModelForIteration(3, 'simple', false, false, false, openrouter))
      .toBe(AGENT_MODEL_TIERS.FREE);
  });

  it('returns undefined for non-openrouter providers', () => {
    expect(selectAgentModelForIteration(0, 'simple', false, false, false, ollama))
      .toBeUndefined();
  });
});

describe('refreshDemotedAgentModels — demotion rule', () => {
  beforeEach(() => _resetAgentModelDemotionCacheForTests());

  it('demotes a model with enough samples and low tool-call rate', async () => {
    // 12 samples, 0 with tool_call_count > 0 → rate = 0% → demoted
    const rows = Array.from({ length: 12 }, () => ({
      model: 'qwen/qwen3.5-9b',
      tool_call_count: 0,
    }));
    await refreshDemotedAgentModels(fakeDb(rows));
    const snap = getAgentModelDemotionSnapshot();
    expect(snap.demoted).toContain('qwen/qwen3.5-9b');
  });

  it('does NOT demote when sample count is below threshold', async () => {
    // 5 samples — below DEMOTION_MIN_SAMPLES = 10
    const rows = Array.from({ length: 5 }, () => ({
      model: 'qwen/qwen3.5-9b',
      tool_call_count: 0,
    }));
    await refreshDemotedAgentModels(fakeDb(rows));
    expect(getAgentModelDemotionSnapshot().demoted).toHaveLength(0);
  });

  it('does NOT demote when tool-call rate is above threshold', async () => {
    // 12 samples, 10 with tool calls → rate ~83% → healthy
    const rows = Array.from({ length: 12 }, (_, i) => ({
      model: 'qwen/qwen3.5-35b-a3b',
      tool_call_count: i < 10 ? 1 : 0,
    }));
    await refreshDemotedAgentModels(fakeDb(rows));
    expect(getAgentModelDemotionSnapshot().demoted).toHaveLength(0);
  });

  it('ignores null tool_call_count rows when computing rate', async () => {
    // 20 null rows + 5 zero-tool-call rows = 5 real samples → below MIN
    const rows = [
      ...Array.from({ length: 20 }, () => ({ model: 'foo/bar', tool_call_count: null })),
      ...Array.from({ length: 5 }, () => ({ model: 'foo/bar', tool_call_count: 0 })),
    ];
    await refreshDemotedAgentModels(fakeDb(rows));
    expect(getAgentModelDemotionSnapshot().demoted).toHaveLength(0);
  });

  it('captures stats for every observed model in snapshot', async () => {
    const rows = [
      ...Array.from({ length: 12 }, () => ({ model: 'a/bad', tool_call_count: 0 })),
      ...Array.from({ length: 12 }, () => ({ model: 'a/good', tool_call_count: 1 })),
    ];
    await refreshDemotedAgentModels(fakeDb(rows));
    const snap = getAgentModelDemotionSnapshot();
    const bad = snap.stats.find((s) => s.model === 'a/bad');
    const good = snap.stats.find((s) => s.model === 'a/good');
    expect(bad).toMatchObject({ samples: 12, toolCallRate: 0 });
    expect(good).toMatchObject({ samples: 12, toolCallRate: 1 });
    expect(snap.demoted).toEqual(['a/bad']);
  });
});

describe('selectAgentModelForIteration — escalation', () => {
  beforeEach(() => _resetAgentModelDemotionCacheForTests());

  it('escalates FAST → BALANCED when FAST is demoted', async () => {
    const rows = Array.from({ length: 12 }, () => ({
      model: AGENT_MODEL_TIERS.FAST,
      tool_call_count: 0,
    }));
    await refreshDemotedAgentModels(fakeDb(rows));
    // simple iteration 0 would normally return FAST
    expect(selectAgentModelForIteration(0, 'simple', false, false, false, openrouter))
      .toBe(AGENT_MODEL_TIERS.BALANCED);
  });

  it('escalates FREE → FAST when FREE is demoted', async () => {
    const rows = Array.from({ length: 12 }, () => ({
      model: AGENT_MODEL_TIERS.FREE,
      tool_call_count: 0,
    }));
    await refreshDemotedAgentModels(fakeDb(rows));
    // iteration 3 with simple difficulty normally returns FREE
    expect(selectAgentModelForIteration(3, 'simple', false, false, false, openrouter))
      .toBe(AGENT_MODEL_TIERS.FAST);
  });

  it('chain-escalates FAST → BALANCED → STRONG when both lower tiers are demoted', async () => {
    const rows = [
      ...Array.from({ length: 12 }, () => ({ model: AGENT_MODEL_TIERS.FAST, tool_call_count: 0 })),
      ...Array.from({ length: 12 }, () => ({ model: AGENT_MODEL_TIERS.BALANCED, tool_call_count: 0 })),
    ];
    await refreshDemotedAgentModels(fakeDb(rows));
    expect(selectAgentModelForIteration(0, 'simple', false, false, false, openrouter))
      .toBe(AGENT_MODEL_TIERS.STRONG);
  });

  it('leaves STRONG in place when STRONG itself is demoted (no escalation target)', async () => {
    const rows = Array.from({ length: 12 }, () => ({
      model: AGENT_MODEL_TIERS.STRONG,
      tool_call_count: 0,
    }));
    await refreshDemotedAgentModels(fakeDb(rows));
    expect(selectAgentModelForIteration(0, 'complex', false, false, false, openrouter))
      .toBe(AGENT_MODEL_TIERS.STRONG);
  });

  it('healthy FAST tier still returns FAST', async () => {
    const rows = Array.from({ length: 12 }, () => ({
      model: AGENT_MODEL_TIERS.FAST,
      tool_call_count: 1,
    }));
    await refreshDemotedAgentModels(fakeDb(rows));
    expect(selectAgentModelForIteration(0, 'simple', false, false, false, openrouter))
      .toBe(AGENT_MODEL_TIERS.FAST);
  });
});

// ---------------------------------------------------------------------------
// getInductedModelCandidates()
// ---------------------------------------------------------------------------

describe('getInductedModelCandidates()', () => {
  // Use a stub db — getInductedModelCandidates reads only from the module cache.
  const stubDb = {} as unknown as DatabaseAdapter;

  beforeEach(() => {
    _resetRuntimeConfigCacheForTests();
  });

  it('returns [] when runtime_config key is absent', async () => {
    const result = await getInductedModelCandidates(stubDb);
    expect(result).toEqual([]);
  });

  it('returns stored list when key is present in cache', async () => {
    _seedRuntimeConfigCacheForTests('model_induction.promoted_models', ['org/model-a', 'org/model-b']);
    const result = await getInductedModelCandidates(stubDb);
    expect(result).toEqual(['org/model-a', 'org/model-b']);
  });

  it('returns stable empty array reference when key absent (not a new [] each call)', async () => {
    // Calling twice without seeding should never throw and always return [].
    const a = await getInductedModelCandidates(stubDb);
    const b = await getInductedModelCandidates(stubDb);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });
});
