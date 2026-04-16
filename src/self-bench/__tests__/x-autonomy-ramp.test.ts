import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XAutonomyRampExperiment } from '../experiments/x-autonomy-ramp.js';
import type { ExperimentContext } from '../experiment-types.js';

const TEST_SLUG = `autonomy-ramp-test-${Date.now()}`;
const DIR = path.join(os.homedir(), '.ohwow', 'workspaces', TEST_SLUG);

function buildDb(rows: Array<Record<string, unknown>>) {
  const goalsBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.limit = () => Promise.resolve({ data: rows, error: null });
    return b;
  };
  return {
    from: vi.fn().mockImplementation((t: string) => {
      if (t === 'agent_workforce_goals') return goalsBuilder();
      // findings store reads self_findings for x-engagement-observer lookup
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.order = () => b;
      b.limit = () => Promise.resolve({ data: [], error: null });
      return b;
    }),
  };
}

function ctx(db: unknown): ExperimentContext {
  return {
    db: db as never,
    workspaceId: 'ws-1',
    workspaceSlug: TEST_SLUG,
    engine: {} as never,
    recentFindings: async () => [],
  };
}

function writeApprovals(entries: unknown[]): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DIR, 'x-approvals.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf-8',
  );
}

beforeEach(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

afterEach(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('XAutonomyRampExperiment', () => {
  it('reports no-op when no x_posts_per_week goal is set', async () => {
    const db = buildDb([]);
    const exp = new XAutonomyRampExperiment({ allowedWorkspace: TEST_SLUG });
    const res = await exp.probe(ctx(db));
    const ev = res.evidence as { weekly_target: number };
    expect(ev.weekly_target).toBe(0);
    expect(res.summary).toMatch(/no x_posts_per_week goal/);
  });

  it('computes daily_budget=ceil(deficit/days_remaining) when goal exists', async () => {
    const db = buildDb([{ target_value: 7, current_value: 1 }]);
    writeApprovals([
      // 14 approved posts to clear the precedent floor for 'opinion'.
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `a${i}`,
        ts: new Date(Date.now() - i * 60000).toISOString(),
        kind: 'x_outbound_post',
        status: 'approved',
        payload: { shape: 'opinion' },
      })),
    ]);
    const exp = new XAutonomyRampExperiment({ allowedWorkspace: TEST_SLUG });
    const res = await exp.probe(ctx(db));
    const ev = res.evidence as {
      weekly_target: number;
      weekly_actual: number;
      weekly_deficit: number;
      days_remaining: number;
      per_shape: Array<{ shape: string; approved: number; eligible: boolean; daily_budget: number; blocker: string | null }>;
    };
    expect(ev.weekly_target).toBe(7);
    // 20 approved posts, all in this week (ts within last 20 minutes)
    expect(ev.weekly_actual).toBeGreaterThanOrEqual(1);
    // 'opinion' has >=15 approved but no engagement baseline yet — blocked.
    const opinion = ev.per_shape.find((s) => s.shape === 'opinion')!;
    expect(opinion.approved).toBe(20);
    expect(opinion.blocker).toMatch(/engagement baseline/);
  });

  it('daily_budget=0 for all shapes when weekly target is met', async () => {
    const db = buildDb([{ target_value: 7, current_value: 7 }]);
    // 7+ approved posts already landed this week.
    writeApprovals(
      Array.from({ length: 15 }, (_, i) => ({
        id: `a${i}`,
        ts: new Date().toISOString(),
        kind: 'x_outbound_post',
        status: 'approved',
        payload: { shape: 'opinion' },
      })),
    );
    const exp = new XAutonomyRampExperiment({ allowedWorkspace: TEST_SLUG });
    const res = await exp.probe(ctx(db));
    const ev = res.evidence as {
      weekly_deficit: number;
      per_shape: Array<{ daily_budget: number }>;
    };
    expect(ev.weekly_deficit).toBe(0);
    for (const s of ev.per_shape) expect(s.daily_budget).toBe(0);
  });

  it('judge always returns pass (scheduler use only)', async () => {
    const exp = new XAutonomyRampExperiment({ allowedWorkspace: TEST_SLUG });
    // Hand-rolled minimal ProbeResult shape for judge.
    const verdict = exp['businessJudge'](
      { subject: 'x-autonomy:summary', summary: '', evidence: {} },
      [],
    );
    expect(verdict).toBe('pass');
  });
});
