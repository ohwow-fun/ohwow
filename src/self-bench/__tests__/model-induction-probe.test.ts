/**
 * Tests for ModelInductionProbeExperiment.
 *
 * Covers:
 * - Static contract (id, category, cadence)
 * - probe() with empty DB → skipped_reason='no_recent_releases', verdict='warning'
 * - probe() with missing modelRouter → skipped_reason='no_model_router', verdict='warning'
 * - judge() returns 'fail' when all per_model[*].ok===false and candidates_tested>0
 * - judge() returns 'pass' when all per_model[*].ok===true
 * - judge() returns 'warning' when some (but not all) per_model[*].ok===false
 * - intervene() returns null on pass, InterventionApplied on warning/fail
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ModelInductionProbeExperiment,
  TOOL_CALL_PROBE_PROMPT,
  type ModelInductionEvidence,
} from '../experiments/model-induction-probe.js';
import type { ExperimentContext, Finding, ProbeResult } from '../experiment-types.js';

// Mock runLlmCall so tests never hit a real model.
vi.mock('../../execution/llm-organ.js', () => ({
  runLlmCall: vi.fn(),
}));

// Mock runtime-config so intervene() promotion tests never touch a real DB.
// The test-hook helpers are passed through as no-ops; they are only exercised
// in the agent-model-tiers test file which does NOT mock this module.
vi.mock('../runtime-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../runtime-config.js')>();
  return {
    ...real,
    getRuntimeConfig: vi.fn(),
    setRuntimeConfig: vi.fn().mockResolvedValue(undefined),
  };
});

import { runLlmCall } from '../../execution/llm-organ.js';
import {
  getRuntimeConfig,
  setRuntimeConfig,
} from '../runtime-config.js';

const mockRunLlmCall = vi.mocked(runLlmCall);
const mockGetRuntimeConfig = vi.mocked(getRuntimeConfig);
const mockSetRuntimeConfig = vi.mocked(setRuntimeConfig);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal DB builder returning provided rows for self_findings. */
function fakeDb(selfFindingsRows: Array<Record<string, unknown>>) {
  type Filter = { column: string; op: string; value: unknown };
  const build = (table: string, filters: Filter[] = []) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (column: string, value: unknown) => {
      filters.push({ column, op: 'eq', value });
      return chain;
    };
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.then = (resolve: (v: unknown) => void) => {
      if (table !== 'self_findings') return resolve({ data: [], error: null });
      let data = selfFindingsRows;
      for (const f of filters) {
        if (f.op === 'eq') data = data.filter((r) => r[f.column] === f.value);
      }
      return resolve({ data, error: null });
    };
    return chain;
  };
  return { from: (table: string) => build(table) } as unknown as ExperimentContext['db'];
}

/** Build a minimal ExperimentContext. engine can be partial or absent. */
function fakeCtx(
  selfFindingsRows: Array<Record<string, unknown>>,
  engineOverride?: Partial<ExperimentContext['engine']> | null,
  recentFindingsOverride?: (experimentId: string, limit: number) => Promise<Finding[]>,
): ExperimentContext {
  return {
    db: fakeDb(selfFindingsRows),
    workspaceId: 'ws-test',
    engine: (engineOverride === null
      ? undefined
      : (engineOverride ?? {})) as ExperimentContext['engine'],
    recentFindings: recentFindingsOverride ?? (async (): Promise<Finding[]> => []),
  };
}

/** A valid model_releases finding containing one model entry. */
function makeReleaseFinding(
  modelId: string,
  downloads = 1000,
  likes = 50,
): Record<string, unknown> {
  return {
    experiment_id: 'model-release-monitor',
    ran_at: new Date().toISOString(),
    evidence: JSON.stringify({
      families: [
        {
          new_hf_models: [{ id: modelId, downloads, likes }],
        },
      ],
    }),
  };
}

// ---------------------------------------------------------------------------
// Static contract
// ---------------------------------------------------------------------------

describe('ModelInductionProbeExperiment — static contract', () => {
  it('has the expected id, category, and cadence', () => {
    const exp = new ModelInductionProbeExperiment();
    expect(exp.id).toBe('model-induction-probe');
    expect(exp.category).toBe('model_health');
    expect(exp.cadence.everyMs).toBe(24 * 60 * 60 * 1000);
    expect(exp.cadence.runOnBoot).toBe(false);
  });

  it('exports TOOL_CALL_PROBE_PROMPT as a non-empty string', () => {
    expect(typeof TOOL_CALL_PROBE_PROMPT).toBe('string');
    expect(TOOL_CALL_PROBE_PROMPT.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// probe() — skip paths
// ---------------------------------------------------------------------------

describe('ModelInductionProbeExperiment — probe() skip paths', () => {
  it('returns skipped_reason=no_recent_releases when DB is empty', async () => {
    const exp = new ModelInductionProbeExperiment();
    const ctx = fakeCtx([]);
    const result = await exp.probe(ctx);
    const ev = result.evidence as ModelInductionEvidence;

    expect(ev.skipped_reason).toBe('no_recent_releases');
    expect(ev.candidates_found).toBe(0);
    expect(ev.candidates_tested).toBe(0);
    expect(ev.per_model).toEqual([]);
  });

  it('judge returns warning for no_recent_releases', async () => {
    const exp = new ModelInductionProbeExperiment();
    const ctx = fakeCtx([]);
    const result = await exp.probe(ctx);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('returns skipped_reason=no_model_router when engine has no modelRouter', async () => {
    const exp = new ModelInductionProbeExperiment();
    const ctx = fakeCtx([makeReleaseFinding('mistral/mistral-7b')], {});
    // engine is present but modelRouter is absent
    const result = await exp.probe(ctx);
    const ev = result.evidence as ModelInductionEvidence;

    expect(ev.skipped_reason).toBe('no_model_router');
    expect(ev.candidates_tested).toBe(0);
    expect(ev.per_model).toEqual([]);
  });

  it('judge returns warning for no_model_router', async () => {
    const exp = new ModelInductionProbeExperiment();
    const ctx = fakeCtx([makeReleaseFinding('mistral/mistral-7b')], {});
    const result = await exp.probe(ctx);
    expect(exp.judge(result, [])).toBe('warning');
  });
});

// ---------------------------------------------------------------------------
// probe() — live LLM path
// ---------------------------------------------------------------------------

describe('ModelInductionProbeExperiment — probe() with LLM', () => {
  const fakeModelRouter = {} as ExperimentContext['engine']['modelRouter'];

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls runLlmCall for each candidate and records ok=true on success', async () => {
    mockRunLlmCall.mockResolvedValue({
      ok: true,
      data: { text: 'I am good at coding tasks.' } as never,
    } as never);

    const exp = new ModelInductionProbeExperiment();
    const ctx = fakeCtx(
      [makeReleaseFinding('meta/llama-3-8b', 5000, 200)],
      { modelRouter: fakeModelRouter },
    );

    const result = await exp.probe(ctx);
    const ev = result.evidence as ModelInductionEvidence;

    expect(ev.candidates_tested).toBe(1);
    expect(ev.per_model[0].model_id).toBe('meta/llama-3-8b');
    expect(ev.per_model[0].ok).toBe(true);
    expect(ev.per_model[0].response_snippet).toBe('I am good at coding tasks.');
  });

  it('records ok=false with error when runLlmCall fails', async () => {
    mockRunLlmCall.mockResolvedValue({
      ok: false,
      error: 'model not found',
    } as never);

    const exp = new ModelInductionProbeExperiment();
    const ctx = fakeCtx(
      [makeReleaseFinding('unknown/model', 100, 5)],
      { modelRouter: fakeModelRouter },
    );

    const result = await exp.probe(ctx);
    const ev = result.evidence as ModelInductionEvidence;

    expect(ev.per_model[0].ok).toBe(false);
    expect(ev.per_model[0].error).toBe('model not found');
  });

  it('deduplicates models across findings', async () => {
    mockRunLlmCall.mockResolvedValue({
      ok: true,
      data: { text: 'ok' } as never,
    } as never);

    const exp = new ModelInductionProbeExperiment();
    // Same model id in two separate findings
    const ctx = fakeCtx(
      [
        makeReleaseFinding('dup/model-x', 1000, 20),
        makeReleaseFinding('dup/model-x', 1000, 20),
      ],
      { modelRouter: fakeModelRouter },
    );

    const result = await exp.probe(ctx);
    const ev = result.evidence as ModelInductionEvidence;

    expect(ev.candidates_found).toBe(1);
    expect(ev.candidates_tested).toBe(1);
    expect(mockRunLlmCall).toHaveBeenCalledTimes(1);
  });

  it('caps candidates at 3 (MAX_CANDIDATES_PER_TICK)', async () => {
    mockRunLlmCall.mockResolvedValue({
      ok: true,
      data: { text: 'ok' } as never,
    } as never);

    const finding: Record<string, unknown> = {
      experiment_id: 'model-release-monitor',
      ran_at: new Date().toISOString(),
      evidence: JSON.stringify({
        families: [
          {
            new_hf_models: [
              { id: 'a/m1', downloads: 5000, likes: 100 },
              { id: 'a/m2', downloads: 4000, likes: 80 },
              { id: 'a/m3', downloads: 3000, likes: 60 },
              { id: 'a/m4', downloads: 2000, likes: 40 },
              { id: 'a/m5', downloads: 1000, likes: 20 },
            ],
          },
        ],
      }),
    };

    const exp = new ModelInductionProbeExperiment();
    const ctx = fakeCtx([finding], { modelRouter: fakeModelRouter });

    const result = await exp.probe(ctx);
    const ev = result.evidence as ModelInductionEvidence;

    expect(ev.candidates_found).toBe(5);
    expect(ev.candidates_tested).toBe(3);
    expect(mockRunLlmCall).toHaveBeenCalledTimes(3);
  });

  it('subject is the first tested model_id', async () => {
    mockRunLlmCall.mockResolvedValue({
      ok: true,
      data: { text: 'ok' } as never,
    } as never);

    const exp = new ModelInductionProbeExperiment();
    const ctx = fakeCtx(
      [makeReleaseFinding('first/model', 9999, 999)],
      { modelRouter: fakeModelRouter },
    );

    const result = await exp.probe(ctx);
    expect(result.subject).toBe('first/model');
  });
});

// ---------------------------------------------------------------------------
// judge()
// ---------------------------------------------------------------------------

describe('ModelInductionProbeExperiment — judge()', () => {
  const exp = new ModelInductionProbeExperiment();

  function makeResult(ev: ModelInductionEvidence): ProbeResult {
    return {
      subject: null,
      summary: 'test',
      evidence: ev as unknown as Record<string, unknown>,
    };
  }

  it('returns pass when all per_model entries have ok=true', () => {
    const result = makeResult({
      candidates_found: 2,
      candidates_tested: 2,
      per_model: [
        { model_id: 'a', score: 1, ok: true, latency_ms: 100, response_snippet: 'ok' },
        { model_id: 'b', score: 0.5, ok: true, latency_ms: 120, response_snippet: 'ok' },
      ],
    });
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('returns fail when all per_model entries have ok=false and candidates_tested>0', () => {
    const result = makeResult({
      candidates_found: 2,
      candidates_tested: 2,
      per_model: [
        { model_id: 'a', score: 1, ok: false, latency_ms: 50, response_snippet: '', error: 'err' },
        { model_id: 'b', score: 0.5, ok: false, latency_ms: 60, response_snippet: '', error: 'err' },
      ],
    });
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('returns warning when some (but not all) per_model entries have ok=false', () => {
    const result = makeResult({
      candidates_found: 2,
      candidates_tested: 2,
      per_model: [
        { model_id: 'a', score: 1, ok: true, latency_ms: 100, response_snippet: 'ok' },
        { model_id: 'b', score: 0.5, ok: false, latency_ms: 60, response_snippet: '', error: 'err' },
      ],
    });
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('returns warning when skipped_reason is present', () => {
    const result = makeResult({
      candidates_found: 0,
      candidates_tested: 0,
      skipped_reason: 'no_recent_releases',
      per_model: [],
    });
    expect(exp.judge(result, [])).toBe('warning');
  });
});

// ---------------------------------------------------------------------------
// intervene()
// ---------------------------------------------------------------------------

describe('ModelInductionProbeExperiment — intervene()', () => {
  const exp = new ModelInductionProbeExperiment();
  const noopCtx = fakeCtx([]) as ExperimentContext;

  function makeResult(ev: ModelInductionEvidence): ProbeResult {
    return {
      subject: null,
      summary: 'test',
      evidence: ev as unknown as Record<string, unknown>,
    };
  }

  it('returns null on pass verdict', async () => {
    const result = makeResult({
      candidates_found: 1,
      candidates_tested: 1,
      per_model: [
        { model_id: 'a', score: 1, ok: true, latency_ms: 100, response_snippet: 'ok' },
      ],
    });
    expect(await exp.intervene('pass', result, noopCtx)).toBeNull();
  });

  it('returns null on warning/fail when per_model is empty (skipped)', async () => {
    const result = makeResult({
      candidates_found: 0,
      candidates_tested: 0,
      skipped_reason: 'no_recent_releases',
      per_model: [],
    });
    expect(await exp.intervene('warning', result, noopCtx)).toBeNull();
  });

  it('returns InterventionApplied on warning when per_model has entries', async () => {
    const result = makeResult({
      candidates_found: 2,
      candidates_tested: 2,
      per_model: [
        { model_id: 'a', score: 1, ok: true, latency_ms: 100, response_snippet: 'ok' },
        { model_id: 'b', score: 0.5, ok: false, latency_ms: 60, response_snippet: '', error: 'err' },
      ],
    });
    const intervention = await exp.intervene('warning', result, noopCtx);
    expect(intervention).not.toBeNull();
    expect(intervention?.description).toContain('2 model');
    expect(intervention?.description).toContain('1 passed');
    expect(intervention?.description).toContain('1 failed');
  });

  it('returns InterventionApplied on fail verdict', async () => {
    const result = makeResult({
      candidates_found: 1,
      candidates_tested: 1,
      per_model: [
        { model_id: 'a', score: 1, ok: false, latency_ms: 50, response_snippet: '', error: 'err' },
      ],
    });
    const intervention = await exp.intervene('fail', result, noopCtx);
    expect(intervention).not.toBeNull();
    expect(intervention?.description).toContain('0 passed');
    expect(intervention?.description).toContain('1 failed');
  });
});

// ---------------------------------------------------------------------------
// intervene() — promotion hook (consecutive-pass path)
// ---------------------------------------------------------------------------

describe('ModelInductionProbeExperiment — intervene() promotion hook', () => {
  const exp = new ModelInductionProbeExperiment();

  /** Minimal Finding whose evidence encodes a ModelInductionEvidence. */
  function makePriorFinding(ev: ModelInductionEvidence): Finding {
    return {
      id: 'finding-prev',
      experimentId: 'model-induction-probe',
      category: 'model_health',
      subject: null,
      hypothesis: null,
      verdict: 'pass',
      summary: 'prior pass',
      // intervene() tries JSON.parse first, then falls back to raw object.
      // Storing as a JSON string inside the Record satisfies both branches.
      evidence: JSON.stringify(ev) as unknown as Record<string, unknown>,
      interventionApplied: null,
      ranAt: new Date(Date.now() - 86400_000).toISOString(),
      durationMs: 500,
      status: 'active',
      supersededBy: null,
      createdAt: new Date(Date.now() - 86400_000).toISOString(),
    };
  }

  function makeResult(ev: ModelInductionEvidence): ProbeResult {
    return {
      subject: null,
      summary: 'test',
      evidence: ev as unknown as Record<string, unknown>,
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no existing promoted models in pool.
    mockGetRuntimeConfig.mockReturnValue([]);
    mockSetRuntimeConfig.mockResolvedValue(undefined);
  });

  it('promotes model when current pass AND prior finding also had ok=true for same model', async () => {
    const modelId = 'org/consecutive-model';
    const priorFinding = makePriorFinding({
      candidates_found: 1,
      candidates_tested: 1,
      per_model: [{ model_id: modelId, score: 1, ok: true, latency_ms: 100, response_snippet: 'ok' }],
    });
    const ctx = fakeCtx(
      [],
      undefined,
      async () => [priorFinding],
    );
    const result = makeResult({
      candidates_found: 1,
      candidates_tested: 1,
      per_model: [{ model_id: modelId, score: 1, ok: true, latency_ms: 110, response_snippet: 'ok' }],
    });

    const intervention = await exp.intervene('pass', result, ctx);

    expect(intervention).not.toBeNull();
    expect(intervention?.description).toContain('Promoted 1 model');
    expect(mockSetRuntimeConfig).toHaveBeenCalledTimes(1);
    const [, key, value] = mockSetRuntimeConfig.mock.calls[0];
    expect(key).toBe('model_induction.promoted_models');
    expect(value).toContain(modelId);
  });

  it('does NOT duplicate model when it is already in the promoted pool (idempotent)', async () => {
    const modelId = 'org/already-promoted';
    // Simulate: model is already in the runtime_config pool.
    mockGetRuntimeConfig.mockReturnValue([modelId]);

    const priorFinding = makePriorFinding({
      candidates_found: 1,
      candidates_tested: 1,
      per_model: [{ model_id: modelId, score: 1, ok: true, latency_ms: 100, response_snippet: 'ok' }],
    });
    const ctx = fakeCtx([], undefined, async () => [priorFinding]);
    const result = makeResult({
      candidates_found: 1,
      candidates_tested: 1,
      per_model: [{ model_id: modelId, score: 1, ok: true, latency_ms: 110, response_snippet: 'ok' }],
    });

    // toPromote is empty because model already in current, so intervene returns null.
    const intervention = await exp.intervene('pass', result, ctx);

    expect(intervention).toBeNull();
    expect(mockSetRuntimeConfig).not.toHaveBeenCalled();
  });

  it('writes nothing when no prior finding exists for the model (first-run grace)', async () => {
    // recentFindings returns empty — no history yet.
    const ctx = fakeCtx([], undefined, async () => []);
    const result = makeResult({
      candidates_found: 1,
      candidates_tested: 1,
      per_model: [{ model_id: 'org/new-model', score: 1, ok: true, latency_ms: 100, response_snippet: 'ok' }],
    });

    const intervention = await exp.intervene('pass', result, ctx);

    expect(intervention).toBeNull();
    expect(mockSetRuntimeConfig).not.toHaveBeenCalled();
  });

  it('writes nothing when prior finding had ok=false for that model', async () => {
    const modelId = 'org/flaky-model';
    const priorFinding = makePriorFinding({
      candidates_found: 1,
      candidates_tested: 1,
      per_model: [{ model_id: modelId, score: 1, ok: false, latency_ms: 50, response_snippet: '', error: 'timeout' }],
    });
    const ctx = fakeCtx([], undefined, async () => [priorFinding]);
    const result = makeResult({
      candidates_found: 1,
      candidates_tested: 1,
      per_model: [{ model_id: modelId, score: 1, ok: true, latency_ms: 110, response_snippet: 'ok' }],
    });

    const intervention = await exp.intervene('pass', result, ctx);

    expect(intervention).toBeNull();
    expect(mockSetRuntimeConfig).not.toHaveBeenCalled();
  });

  it('merged list passed to setRuntimeConfig deduplicates across multiple candidates', async () => {
    const modelA = 'org/model-a';
    const modelB = 'org/model-b';
    // Both in prior finding with ok=true.
    const priorFinding = makePriorFinding({
      candidates_found: 2,
      candidates_tested: 2,
      per_model: [
        { model_id: modelA, score: 2, ok: true, latency_ms: 100, response_snippet: 'ok' },
        { model_id: modelB, score: 1, ok: true, latency_ms: 120, response_snippet: 'ok' },
      ],
    });
    const ctx = fakeCtx([], undefined, async () => [priorFinding]);
    const result = makeResult({
      candidates_found: 2,
      candidates_tested: 2,
      per_model: [
        { model_id: modelA, score: 2, ok: true, latency_ms: 105, response_snippet: 'ok' },
        { model_id: modelB, score: 1, ok: true, latency_ms: 125, response_snippet: 'ok' },
      ],
    });

    const intervention = await exp.intervene('pass', result, ctx);

    expect(intervention).not.toBeNull();
    const [, , value] = mockSetRuntimeConfig.mock.calls[0];
    const promoted = value as string[];
    // Both models promoted, no duplicates.
    expect(promoted).toContain(modelA);
    expect(promoted).toContain(modelB);
    expect(new Set(promoted).size).toBe(promoted.length);
  });
});
