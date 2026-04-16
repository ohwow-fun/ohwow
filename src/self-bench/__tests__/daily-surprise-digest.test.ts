import { describe, it, expect, vi } from 'vitest';
import { DailySurpriseDigestExperiment } from '../experiments/daily-surprise-digest.js';
import type { ExperimentContext, Finding } from '../experiment-types.js';

function buildDb(priorFindings: Finding[] = [], distilledRows: Record<string, unknown>[] = []) {
  function makeBuilder(name: string) {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.order = () => b;
    if (name === 'self_findings') {
      b.limit = () => Promise.resolve({
        data: priorFindings.map((f) => ({
          id: f.id,
          experiment_id: f.experimentId,
          category: f.category,
          subject: f.subject,
          hypothesis: f.hypothesis,
          verdict: f.verdict,
          summary: f.summary,
          evidence: JSON.stringify(f.evidence),
          intervention_applied: null,
          ran_at: f.ranAt,
          duration_ms: f.durationMs,
          status: 'active',
          superseded_by: null,
          created_at: f.createdAt,
        })),
        error: null,
      });
    } else if (name === 'self_observation_baselines') {
      b.limit = () => Promise.resolve({ data: [], error: null });
    } else {
      b.limit = () => Promise.resolve({ data: distilledRows, error: null });
    }
    return b;
  }
  return { from: vi.fn().mockImplementation((n: string) => makeBuilder(n)) };
}

function ctx(db: unknown): ExperimentContext {
  return {
    db: db as never,
    workspaceId: 'ws-1',
    workspaceSlug: 'default',
    engine: {} as never,
    recentFindings: async () => [],
  };
}

describe('DailySurpriseDigestExperiment', () => {
  it('composes a narrative summary when no prior digest landed today', async () => {
    const db = buildDb([]);
    const exp = new DailySurpriseDigestExperiment();
    const res = await exp.probe(ctx(db));
    expect(res.subject?.startsWith('digest:')).toBe(true);
    expect(res.summary).toMatch(/Today the system noticed/);
    expect(exp.judge(res, [])).toBe('pass');
  });

  it('gates on "already ran today" when a prior digest is present', async () => {
    const today = new Date().toISOString();
    const db = buildDb([
      {
        id: 'prior',
        experimentId: 'daily-surprise-digest',
        category: 'other',
        subject: `digest:${today.slice(0, 10)}`,
        hypothesis: null,
        verdict: 'pass',
        summary: 'yesterday is today already',
        evidence: {},
        interventionApplied: null,
        ranAt: today,
        durationMs: 0,
        status: 'active',
        supersededBy: null,
        createdAt: today,
      },
    ]);
    const exp = new DailySurpriseDigestExperiment();
    const res = await exp.probe(ctx(db));
    expect(res.evidence.skipped).toBe(true);
    expect(res.evidence.reason).toBe('already_ran_today');
  });

  it('always returns pass so the reactive reschedule pathway stays clean', async () => {
    const exp = new DailySurpriseDigestExperiment();
    const res = await exp.probe(ctx(buildDb([])));
    expect(exp.judge(res, [])).toBe('pass');
  });
});
