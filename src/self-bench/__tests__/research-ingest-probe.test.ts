import { describe, it, expect } from 'vitest';
import {
  ResearchIngestProbeExperiment,
  type ResearchIngestEvidence,
} from '../experiments/research-ingest-probe.js';
import type { ArxivPaper } from '../../integrations/arxiv-scraper.js';
import type { ExperimentContext, Finding } from '../experiment-types.js';

/**
 * In-memory fake DatabaseAdapter narrow enough for this experiment's
 * read + insert surface. Records inserts so assertions can inspect
 * what landed in self_findings / knowledge_documents / queue.
 */
function fakeDb(rows: Record<string, Array<Record<string, unknown>>>) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  type Filter = { column: string; op: string; value: unknown };
  const build = (table: string, filters: Filter[] = []) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (column: string, value: unknown) => {
      filters.push({ column, op: 'eq', value });
      return chain;
    };
    chain.in = (column: string, values: unknown[]) => {
      filters.push({ column, op: 'in', value: values });
      return chain;
    };
    chain.gt = (column: string, value: unknown) => {
      filters.push({ column, op: 'gt', value });
      return chain;
    };
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.insert = (row: Record<string, unknown>) => {
      inserts.push({ table, row });
      return Promise.resolve({ data: null, error: null });
    };
    chain.then = (resolve: (v: unknown) => void) => {
      let data = rows[table] ?? [];
      for (const f of filters) {
        if (f.op === 'eq') data = data.filter((r) => r[f.column] === f.value);
        if (f.op === 'in')
          data = data.filter((r) => (f.value as unknown[]).includes(r[f.column]));
      }
      return resolve({ data, error: null });
    };
    return chain;
  };
  const db = { from: (table: string) => build(table) } as unknown as ExperimentContext['db'];
  return { db, inserts };
}

function fakeCtx(rows: Record<string, Array<Record<string, unknown>>>): {
  ctx: ExperimentContext;
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
} {
  const { db, inserts } = fakeDb(rows);
  return {
    ctx: {
      db,
      workspaceId: 'ws-test',
      engine: {} as ExperimentContext['engine'],
      recentFindings: async (): Promise<Finding[]> => [],
    },
    inserts,
  };
}

const samplePaper: ArxivPaper = {
  id: '2103.04529v3',
  title: 'Self-Supervised Online Reward Shaping in Sparse-Reward Environments',
  summary: 'We introduce SORS, improving sample efficiency.',
  authors: ['Alice'],
  published: '2021-03-08T00:00:00Z',
  pdf_url: 'http://arxiv.org/pdf/2103.04529v3',
  primary_category: 'cs.LG',
};

describe('ResearchIngestProbeExperiment', () => {
  it('runs the general pass on its own even when no observation exists', async () => {
    // No observation-probe finding → only general pass should run.
    const { ctx, inserts } = fakeCtx({ self_findings: [] });
    const exp = new ResearchIngestProbeExperiment(async () => [samplePaper]);
    const r = await exp.probe(ctx);
    const ev = r.evidence as ResearchIngestEvidence;
    expect(ev.general_slug).not.toBeNull();
    expect(ev.candidate_codes).toEqual([]);
    // fetcher was invoked → a paper was also handed to the KB-ingest path
    const kbInserts = inserts.filter((i) => i.table === 'agent_workforce_knowledge_documents');
    expect(kbInserts.length).toBe(1);
    expect(kbInserts[0].row.source_type).toBe('arxiv');
  });

  it('queries per anomaly code when observation-probe has error/warn findings', async () => {
    const obs = {
      anomalies: [{ code: 'PATCH_AUTHOR_TOP_PICK_NULL', severity: 'warn', detail: '' }],
    };
    const { ctx, inserts } = fakeCtx({
      self_findings: [
        {
          ran_at: '2026-04-16T19:00:00Z',
          experiment_id: 'observation-probe',
          evidence: JSON.stringify(obs),
        },
      ],
    });
    const calls: string[] = [];
    const exp = new ResearchIngestProbeExperiment(async (spec) => {
      calls.push(spec.query);
      return [samplePaper];
    });
    const r = await exp.probe(ctx);
    const ev = r.evidence as ResearchIngestEvidence;
    // General pass + one anomaly-seeded pass both fire on a cold start.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(ev.candidate_codes).toContain('PATCH_AUTHOR_TOP_PICK_NULL');
    expect(ev.eligible_codes).toContain('PATCH_AUTHOR_TOP_PICK_NULL');
    const ingestInserts = inserts.filter(
      (i) => i.table === 'agent_workforce_knowledge_documents',
    );
    expect(ingestInserts.length).toBeGreaterThanOrEqual(1);
  });

  it('skips codes with no research-query mapping', async () => {
    const obs = {
      anomalies: [{ code: 'NO_AUTONOMOUS_COMMITS', severity: 'warn', detail: '' }],
    };
    const { ctx } = fakeCtx({
      self_findings: [
        {
          ran_at: '2026-04-16T19:00:00Z',
          experiment_id: 'observation-probe',
          evidence: JSON.stringify(obs),
        },
      ],
    });
    const calls: string[] = [];
    const exp = new ResearchIngestProbeExperiment(async (spec) => {
      calls.push(spec.query);
      return [samplePaper];
    });
    const r = await exp.probe(ctx);
    const ev = r.evidence as ResearchIngestEvidence;
    // Only general-pass fetcher call — NO_AUTONOMOUS_COMMITS has no mapping.
    expect(ev.candidate_codes).toEqual(['NO_AUTONOMOUS_COMMITS']);
    expect(ev.eligible_codes).toEqual([]);
    // General still fires at least once
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('judge returns warning when fetcher consistently returns zero papers', async () => {
    const { ctx } = fakeCtx({ self_findings: [] });
    const exp = new ResearchIngestProbeExperiment(async () => []);
    const r = await exp.probe(ctx);
    expect(exp.judge(r, [])).toBe('warning');
  });

  it('judge returns pass for idle tick (everything on cooldown)', async () => {
    // Seed self_findings with a very recent general-pass finding so cooldown kicks in.
    const { ctx } = fakeCtx({
      self_findings: [
        {
          subject: 'research-ingest:general:autonomous-agents',
          ran_at: new Date().toISOString(),
          experiment_id: 'research-ingest-probe',
        },
        {
          subject: 'research-ingest:general:llm-tool-use',
          ran_at: new Date().toISOString(),
          experiment_id: 'research-ingest-probe',
        },
        {
          subject: 'research-ingest:general:self-improving-systems',
          ran_at: new Date().toISOString(),
          experiment_id: 'research-ingest-probe',
        },
        {
          subject: 'research-ingest:general:ai-broad',
          ran_at: new Date().toISOString(),
          experiment_id: 'research-ingest-probe',
        },
      ],
    });
    const exp = new ResearchIngestProbeExperiment(async () => [samplePaper]);
    const r = await exp.probe(ctx);
    const ev = r.evidence as ResearchIngestEvidence;
    expect(ev.general_slug).toBeNull(); // all on cooldown
    expect(exp.judge(r, [])).toBe('pass');
  });
});
