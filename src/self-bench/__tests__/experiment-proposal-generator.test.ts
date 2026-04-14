import { describe, it, expect, vi } from 'vitest';
import { ExperimentProposalGenerator } from '../experiments/experiment-proposal-generator.js';
import type { Experiment, ExperimentContext } from '../experiment-types.js';

/**
 * DB stub supporting:
 *   .from('llm_calls').select(...).gte('created_at', val).limit(n)
 *   .from('self_findings').select(...).eq('category', 'experiment_proposal').gte(...).limit(...)
 *   .from('self_findings').insert(row)  — from intervene's writeFinding calls
 *
 * Bucketed by table so different calls get different data.
 */
function buildDb(seed: {
  llm_calls?: Array<Record<string, unknown>>;
  existing_proposals?: Array<Record<string, unknown>>;
}) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    llm_calls: seed.llm_calls ?? [],
    self_findings: seed.existing_proposals ?? [],
  };

  function makeBuilder(table: string) {
    const filters: Array<{ col: string; op: 'eq' | 'gte'; val: unknown }> = [];
    let limitN: number | null = null;

    const apply = () => {
      let out = tables[table].filter((row) =>
        filters.every((f) => {
          if (f.op === 'eq') return row[f.col] === f.val;
          if (f.op === 'gte') return String(row[f.col] ?? '') >= String(f.val);
          return true;
        }),
      );
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };

    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => { filters.push({ col, op: 'eq', val }); return builder; };
    builder.gte = (col: string, val: unknown) => { filters.push({ col, op: 'gte', val }); return builder; };
    builder.limit = (n: number) => {
      limitN = n;
      return Promise.resolve({ data: apply(), error: null });
    };
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: apply(), error: null });
    builder.insert = (row: Record<string, unknown>) => {
      tables[table].push({ ...row });
      return Promise.resolve({ data: null, error: null });
    };
    return builder;
  }

  return {
    db: { from: vi.fn().mockImplementation((table: string) => makeBuilder(table)) },
    tables,
  };
}

function makeCtx(env: ReturnType<typeof buildDb>): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: env.db as any,
    workspaceId: 'ws-1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async () => [],
  };
}

function llmCall(model: string, latencyMs: number, agoHours = 1) {
  return {
    model,
    latency_ms: latencyMs,
    created_at: new Date(Date.now() - agoHours * 60 * 60 * 1000).toISOString(),
  };
}

describe('ExperimentProposalGenerator', () => {
  const exp: Experiment = new ExperimentProposalGenerator();

  it('warning verdict when no llm_calls rows exist', async () => {
    const env = buildDb({});
    const result = await exp.probe(makeCtx(env));
    expect(result.summary).toContain('no llm_calls');
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('skips models with fewer than MIN_CALLS_FOR_PROPOSAL samples', async () => {
    const env = buildDb({
      llm_calls: Array.from({ length: 10 }, () => llmCall('small/sample', 100)),
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { new_proposals: number; skipped_due_to_low_samples: number };
    expect(ev.new_proposals).toBe(0);
    expect(ev.skipped_due_to_low_samples).toBe(1);
  });

  it('proposes a latency probe for a model with enough samples', async () => {
    const env = buildDb({
      llm_calls: Array.from({ length: 30 }, (_, i) => llmCall('qwen/qwen3.5-35b-a3b', 1000 + i * 50)),
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as {
      new_proposals: number;
      proposals: Array<{ slug: string; template: string; params: Record<string, unknown> }>;
    };
    expect(ev.new_proposals).toBe(1);
    expect(ev.proposals[0].slug).toBe('qwen-qwen3-5-35b-a3b-latency');
    expect(ev.proposals[0].template).toBe('model_latency_probe');
    expect(ev.proposals[0].params.model_id).toBe('qwen/qwen3.5-35b-a3b');
  });

  it('derives warn/fail thresholds from observed distribution', async () => {
    const env = buildDb({
      // 30 samples ascending 1000..2450 (step 50ms)
      llm_calls: Array.from({ length: 30 }, (_, i) => llmCall('acme/model', 1000 + i * 50)),
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { proposals: Array<{ params: { warn_latency_ms: number; fail_latency_ms: number } }> };
    const p = ev.proposals[0].params;
    // p90 of ascending 1000..2450 is around 2350-2450 range
    expect(p.warn_latency_ms).toBeGreaterThanOrEqual(2000);
    // fail must be strictly greater than warn
    expect(p.fail_latency_ms).toBeGreaterThan(p.warn_latency_ms);
  });

  it('dedupe: does NOT re-propose a slug already in the ledger', async () => {
    const env = buildDb({
      llm_calls: Array.from({ length: 30 }, () => llmCall('qwen/qwen3.5-35b-a3b', 1500)),
      existing_proposals: [
        {
          id: 'old-1',
          experiment_id: 'experiment-proposal-generator',
          category: 'experiment_proposal',
          subject: 'proposal:qwen-qwen3-5-35b-a3b-latency',
          ran_at: new Date().toISOString(),
        },
      ],
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { new_proposals: number; existing_proposals: number };
    expect(ev.new_proposals).toBe(0);
    expect(ev.existing_proposals).toBe(1);
  });

  it('intervene writes one self_findings row per new proposal', async () => {
    const env = buildDb({
      llm_calls: [
        ...Array.from({ length: 30 }, () => llmCall('a/model', 500)),
        ...Array.from({ length: 30 }, () => llmCall('b/model', 1000)),
      ],
    });
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('pass', result, ctx);
    expect(intervention).not.toBeNull();
    const details = intervention!.details as { proposal_count: number; slugs: string[] };
    expect(details.proposal_count).toBe(2);
    expect(details.slugs.sort()).toEqual(['a-model-latency', 'b-model-latency']);
    // Two rows written to self_findings (both have category=experiment_proposal)
    const proposalRows = env.tables.self_findings.filter(
      (r) => r.category === 'experiment_proposal',
    );
    expect(proposalRows).toHaveLength(2);
  });

  it('each proposal finding embeds a valid ExperimentBrief in evidence', async () => {
    const env = buildDb({
      llm_calls: Array.from({ length: 30 }, () => llmCall('qwen/qwen3.5-35b-a3b', 1500)),
    });
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    await exp.intervene!('pass', result, ctx);
    const proposal = env.tables.self_findings.find(
      (r) => r.category === 'experiment_proposal',
    );
    expect(proposal).toBeDefined();
    const evidence = JSON.parse(proposal!.evidence as string);
    expect(evidence.is_experiment_proposal).toBe(true);
    expect(evidence.claimed).toBe(false);
    expect(evidence.brief.template).toBe('model_latency_probe');
    expect(evidence.brief.slug).toBe('qwen-qwen3-5-35b-a3b-latency');
    expect(evidence.brief.params.model_id).toBe('qwen/qwen3.5-35b-a3b');
  });

  it('intervene returns null when no new proposals were generated', async () => {
    const env = buildDb({
      llm_calls: Array.from({ length: 30 }, () => llmCall('qwen/qwen3.5-35b-a3b', 1500)),
      existing_proposals: [
        {
          id: 'old-1',
          experiment_id: 'experiment-proposal-generator',
          category: 'experiment_proposal',
          subject: 'proposal:qwen-qwen3-5-35b-a3b-latency',
          ran_at: new Date().toISOString(),
        },
      ],
    });
    const ctx = makeCtx(env);
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('pass', result, ctx);
    expect(intervention).toBeNull();
  });

  it('generated briefs pass validateBrief (end-to-end template compatibility)', async () => {
    const { validateBrief } = await import('../experiment-template.js');
    const env = buildDb({
      llm_calls: Array.from({ length: 30 }, (_, i) => llmCall('valid/model-id', 800 + i * 10)),
    });
    const result = await exp.probe(makeCtx(env));
    const ev = result.evidence as { proposals: Array<unknown> };
    for (const brief of ev.proposals) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = validateBrief(brief as any);
      expect(err).toBeNull();
    }
  });
});
