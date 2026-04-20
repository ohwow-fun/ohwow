import { describe, it, expect, vi } from 'vitest';
import {
  ModelReleaseMonitorExperiment,
  _internal,
  type HfModelEntry,
  type ModelReleaseEvidence,
} from '../experiments/model-release-monitor.js';
import type { ArxivPaper } from '../../integrations/arxiv-scraper.js';
import type { ExperimentContext, Finding } from '../experiment-types.js';

// ---------------------------------------------------------------------------
// Minimal fake DB that handles the ingestKnowledgeText insert surface.
// ---------------------------------------------------------------------------
function fakeDb(existingSourceUrls: string[] = []) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const db = {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.in = () => chain;
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.insert = (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return Promise.resolve({ data: null, error: null });
      };
      chain.then = (resolve: (v: unknown) => void) => {
        // Simulate the dedup check in ingestKnowledgeText: return existing rows
        // for known source_urls so the "duplicate" path fires.
        const sourceUrl = (chain as Record<string, unknown>)['_sourceUrl'] as string | undefined;
        const data =
          table === 'agent_workforce_knowledge_documents' && sourceUrl
            ? existingSourceUrls.includes(sourceUrl)
              ? [{ id: 'existing-id' }]
              : []
            : [];
        return resolve({ data, error: null });
      };
      // Capture eq value so the dedup check works.
      chain.eq = (col: string, val: unknown) => {
        if (col === 'source_url') (chain as Record<string, unknown>)['_sourceUrl'] = val;
        return chain;
      };
      return chain;
    },
  } as unknown as ExperimentContext['db'];
  return { db, inserts };
}

function fakeCtx(existingSourceUrls: string[] = []): {
  ctx: ExperimentContext;
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
} {
  const { db, inserts } = fakeDb(existingSourceUrls);
  return {
    ctx: {
      db,
      workspaceId: 'test-workspace',
      workspaceSlug: 'test',
      engine: {} as ExperimentContext['engine'],
      recentFindings: async () => [] as Finding[],
    },
    inserts,
  };
}

function makeHfModel(id: string, minsAgo = 30): HfModelEntry {
  return {
    id,
    lastModified: new Date(Date.now() - minsAgo * 60 * 1000).toISOString(),
    downloads: 100,
    likes: 10,
    tags: ['text-generation'],
  };
}

function makeArxivPaper(id: string): ArxivPaper {
  return {
    id,
    title: `Paper about ${id}`,
    summary: 'Abstract text that is long enough to pass the 80-byte minimum check in the KB ingest.',
    authors: ['Author One'],
    published: new Date().toISOString(),
    pdf_url: null,
    primary_category: 'cs.CL',
  };
}

// ---------------------------------------------------------------------------
// Static contract: id, category, cadence
// ---------------------------------------------------------------------------
describe('ModelReleaseMonitorExperiment — static contract', () => {
  const exp = new ModelReleaseMonitorExperiment();

  it('has the correct id', () => {
    expect(exp.id).toBe('model-release-monitor');
  });

  it('has category model_releases', () => {
    expect(exp.category).toBe('model_releases');
  });

  it('cadence is 12 hours', () => {
    expect(exp.cadence.everyMs).toBe(12 * 60 * 60 * 1000);
  });

  it('runs on boot', () => {
    expect(exp.cadence.runOnBoot).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// probe() — no new releases
// ---------------------------------------------------------------------------
describe('ModelReleaseMonitorExperiment.probe — no new releases', () => {
  it('returns a pass-shaped result when fetchers return empty', async () => {
    const { ctx } = fakeCtx();
    const exp = new ModelReleaseMonitorExperiment(
      async () => [],
      async () => [],
    );
    const result = await exp.probe(ctx);
    const ev = result.evidence as ModelReleaseEvidence;
    expect(ev.total_new_models).toBe(0);
    expect(ev.total_new_papers).toBe(0);
    expect(ev.total_ingested).toBe(0);
    expect(ev.families_checked).toBe(_internal.TRACKED_FAMILIES.length);
    expect(result.summary).toContain('no new releases');
  });
});

// ---------------------------------------------------------------------------
// probe() — new releases found
// ---------------------------------------------------------------------------
describe('ModelReleaseMonitorExperiment.probe — new releases', () => {
  it('counts new HF models and papers correctly', async () => {
    const { ctx } = fakeCtx();
    const exp = new ModelReleaseMonitorExperiment(
      async (family) => (family === 'qwen' ? [makeHfModel('Qwen/Qwen3-7B')] : []),
      async (family) => (family === 'qwen' ? [makeArxivPaper('2501.00001')] : []),
    );
    const result = await exp.probe(ctx);
    const ev = result.evidence as ModelReleaseEvidence;
    expect(ev.total_new_models).toBe(1);
    expect(ev.total_new_papers).toBe(1);
    expect(result.summary).toContain('1 new model(s)');
  });

  it('mentions top model id in summary', async () => {
    const { ctx } = fakeCtx();
    const exp = new ModelReleaseMonitorExperiment(
      async (family) => (family === 'deepseek' ? [makeHfModel('deepseek-ai/DeepSeek-V3')] : []),
      async () => [],
    );
    const result = await exp.probe(ctx);
    expect(result.summary).toContain('deepseek-ai/DeepSeek-V3');
  });

  it('records ingestion outcome per model', async () => {
    const { ctx } = fakeCtx();
    const exp = new ModelReleaseMonitorExperiment(
      async (family) => (family === 'mistral' ? [makeHfModel('mistralai/Mistral-7B-v0.3')] : []),
      async () => [],
    );
    const result = await exp.probe(ctx);
    const ev = result.evidence as ModelReleaseEvidence;
    const mistralResult = ev.families.find((f) => f.family === 'mistral');
    expect(mistralResult).toBeDefined();
    expect(mistralResult!.hf_ingested).toHaveLength(1);
    expect(mistralResult!.hf_ingested[0].id).toBe('mistralai/Mistral-7B-v0.3');
  });
});

// ---------------------------------------------------------------------------
// probe() — error handling
// ---------------------------------------------------------------------------
describe('ModelReleaseMonitorExperiment.probe — errors', () => {
  it('records hf_error per family and continues', async () => {
    const { ctx } = fakeCtx();
    const exp = new ModelReleaseMonitorExperiment(
      async () => { throw new Error('HF 429'); },
      async () => [],
    );
    const result = await exp.probe(ctx);
    const ev = result.evidence as ModelReleaseEvidence;
    expect(ev.families.every((f) => f.hf_error === 'HF 429')).toBe(true);
    expect(ev.total_new_models).toBe(0);
  });

  it('records arxiv_error per family and continues', async () => {
    const { ctx } = fakeCtx();
    const exp = new ModelReleaseMonitorExperiment(
      async () => [],
      async () => { throw new Error('arXiv timeout'); },
    );
    const result = await exp.probe(ctx);
    const ev = result.evidence as ModelReleaseEvidence;
    expect(ev.families.every((f) => f.arxiv_error === 'arXiv timeout')).toBe(true);
    expect(ev.total_new_papers).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// judge()
// ---------------------------------------------------------------------------
describe('ModelReleaseMonitorExperiment.judge', () => {
  const exp = new ModelReleaseMonitorExperiment();

  function makeResult(
    totalNewModels: number,
    totalNewPapers: number,
    allHfFailed = false,
    allArxivFailed = false,
  ): Parameters<typeof exp.judge>[0] {
    const families = _internal.TRACKED_FAMILIES.map((family) => ({
      family,
      new_hf_models: [],
      new_papers: [],
      hf_ingested: [],
      paper_ingested: [],
      hf_error: allHfFailed ? 'error' : null,
      arxiv_error: allArxivFailed ? 'error' : null,
    }));
    return {
      subject: 'model-releases:scan:test',
      summary: 'test',
      evidence: {
        window_hours: 12,
        families_checked: _internal.TRACKED_FAMILIES.length,
        total_new_models: totalNewModels,
        total_new_papers: totalNewPapers,
        total_ingested: 0,
        families,
        scanned_at: new Date().toISOString(),
      } satisfies ModelReleaseEvidence as unknown as Record<string, unknown>,
    };
  }

  it('returns pass when no new releases', () => {
    expect(exp.judge(makeResult(0, 0), [])).toBe('pass');
  });

  it('returns warning when new models found', () => {
    expect(exp.judge(makeResult(3, 0), [])).toBe('warning');
  });

  it('returns warning when new papers found', () => {
    expect(exp.judge(makeResult(0, 2), [])).toBe('warning');
  });

  it('returns fail when all HF and arXiv calls error', () => {
    expect(exp.judge(makeResult(0, 0, true, true), [])).toBe('fail');
  });

  it('returns pass when only HF errors (arXiv ok)', () => {
    expect(exp.judge(makeResult(0, 0, true, false), [])).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// intervene()
// ---------------------------------------------------------------------------
describe('ModelReleaseMonitorExperiment.intervene', () => {
  const exp = new ModelReleaseMonitorExperiment();
  const { ctx } = fakeCtx();

  it('returns null on pass verdict', async () => {
    const result = await exp.intervene('pass', {
      subject: null, summary: '', evidence: {
        window_hours: 12, families_checked: 0, total_new_models: 0,
        total_new_papers: 0, total_ingested: 0, families: [], scanned_at: '',
      },
    }, ctx);
    expect(result).toBeNull();
  });

  it('returns null on fail verdict', async () => {
    const result = await exp.intervene('fail', {
      subject: null, summary: '', evidence: {
        window_hours: 12, families_checked: 0, total_new_models: 0,
        total_new_papers: 0, total_ingested: 0, families: [], scanned_at: '',
      },
    }, ctx);
    expect(result).toBeNull();
  });

  it('returns InterventionApplied on warning with top models list', async () => {
    const result = await exp.intervene('warning', {
      subject: null,
      summary: '1 new model',
      evidence: {
        window_hours: 12,
        families_checked: 1,
        total_new_models: 1,
        total_new_papers: 0,
        total_ingested: 1,
        families: [{
          family: 'qwen',
          new_hf_models: [makeHfModel('Qwen/Qwen3-7B')],
          new_papers: [],
          hf_ingested: [{ id: 'Qwen/Qwen3-7B', inserted: true }],
          paper_ingested: [],
          hf_error: null,
          arxiv_error: null,
        }],
        scanned_at: new Date().toISOString(),
      },
    }, ctx);
    expect(result).not.toBeNull();
    expect(result!.description).toContain('Ingested 1');
    expect((result!.details as Record<string, unknown>)['top_models']).toContain('Qwen/Qwen3-7B');
  });
});

// ---------------------------------------------------------------------------
// TRACKED_FAMILIES coverage
// ---------------------------------------------------------------------------
describe('TRACKED_FAMILIES', () => {
  it('includes key model families', () => {
    const families = _internal.TRACKED_FAMILIES as readonly string[];
    for (const expected of ['qwen', 'kimi', 'deepseek', 'mistral', 'llama', 'glm']) {
      expect(families).toContain(expected);
    }
  });
});
