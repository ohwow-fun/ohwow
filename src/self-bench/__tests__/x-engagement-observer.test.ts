import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XEngagementObserverExperiment } from '../experiments/x-engagement-observer.js';
import type { ExperimentContext } from '../experiment-types.js';

const TEST_SLUG = `x-engagement-test-${Date.now()}`;
const DIR = path.join(os.homedir(), '.ohwow', 'workspaces', TEST_SLUG);

function buildDb() {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.order = () => b;
  b.limit = () => Promise.resolve({ data: [], error: null });
  b.insert = () => Promise.resolve({ data: null, error: null });
  return { from: vi.fn().mockImplementation(() => b) };
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

function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DIR, file),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
}

beforeEach(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

afterEach(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('XEngagementObserverExperiment', () => {
  it('reports "waiting for tagging" when no approvals + no snapshots exist', async () => {
    const exp = new XEngagementObserverExperiment({ allowedWorkspace: TEST_SLUG });
    const res = await exp.probe(ctx(buildDb()));
    const ev = res.evidence as { attributed_posts: number };
    expect(ev.attributed_posts).toBe(0);
    expect(res.summary).toMatch(/waiting/);
  });

  it('joins own-post snapshots to approval-queue shape via permalink', async () => {
    writeJsonl('x-own-posts.jsonl', [
      { ts: new Date().toISOString(), permalink: '/me/status/1', likes: 10, replies: 2, reposts: 1 },
      { ts: new Date().toISOString(), permalink: '/me/status/2', likes: 4, replies: 0, reposts: 0 },
    ]);
    writeJsonl('x-approvals.jsonl', [
      {
        id: 'ap1',
        ts: new Date().toISOString(),
        kind: 'x_outbound_post',
        status: 'auto_applied',
        payload: { shape: 'opinion', permalink: '/me/status/1' },
      },
      {
        id: 'ap2',
        ts: new Date().toISOString(),
        kind: 'x_outbound_post',
        status: 'approved',
        payload: { shape: 'opinion', permalink: '/me/status/2' },
      },
    ]);
    const exp = new XEngagementObserverExperiment({ allowedWorkspace: TEST_SLUG });
    const res = await exp.probe(ctx(buildDb()));
    const ev = res.evidence as {
      attributed_posts: number;
      shape_aggregates: Array<{ shape: string; posts: number; median_engagement: number; best_engagement: number }>;
    };
    expect(ev.attributed_posts).toBe(2);
    const opinion = ev.shape_aggregates.find((s) => s.shape === 'opinion')!;
    expect(opinion.posts).toBe(2);
    // Scores: 10+2*2+3*1=17 and 4+0+0=4, median=(17+4)/2=10.5, best=17
    expect(opinion.median_engagement).toBe(10.5);
    expect(opinion.best_engagement).toBe(17);
  });

  it('ignores posts without a shape-attributable approval record', async () => {
    writeJsonl('x-own-posts.jsonl', [
      { ts: new Date().toISOString(), permalink: '/me/status/orphan', likes: 99, replies: 0, reposts: 0 },
    ]);
    // no approvals
    const exp = new XEngagementObserverExperiment({ allowedWorkspace: TEST_SLUG });
    const res = await exp.probe(ctx(buildDb()));
    const ev = res.evidence as { attributed_posts: number };
    expect(ev.attributed_posts).toBe(0);
  });

  it('parent finding always passes (per-shape findings carry the signal)', async () => {
    const exp = new XEngagementObserverExperiment({ allowedWorkspace: TEST_SLUG });
    const res = await exp.probe(ctx(buildDb()));
    expect(exp.judge(res, [])).toBe('pass');
  });
});
