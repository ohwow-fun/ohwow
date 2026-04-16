import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  XOpsObserverExperiment,
  computeEvidence,
  type XOpsObserverEvidence,
} from '../experiments/x-ops-observer.js';
import type { ExperimentContext, Finding } from '../experiment-types.js';

let ledgerDir: string;
const nowIso = new Date('2026-04-16T05:00:00Z').getTime();
const today = '2026-04-16';

function writeLine(rel: string, obj: unknown) {
  const abs = path.join(ledgerDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(obj) + '\n', 'utf-8');
}

function writeFile(rel: string, body: string) {
  const abs = path.join(ledgerDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf-8');
}

function makeCtx(slug: string): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {} as any,
    workspaceId: 'ws-test',
    workspaceSlug: slug,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async (_id: string, _limit?: number) => [] as Finding[],
  };
}

beforeEach(() => {
  ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-ops-'));
});

afterEach(() => {
  try { fs.rmSync(ledgerDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('computeEvidence', () => {
  it('counts approvals, computes dispatch rate, and classifies shapes', () => {
    const baseTs = new Date('2026-04-15T20:00:00Z').toISOString();
    // 3 outbound posts applied, 1 rejected; 2 replies; 2 knowledge uploads
    for (let i = 0; i < 3; i++) {
      writeLine('x-approvals.jsonl', {
        id: `p${i}`, ts: baseTs, kind: 'x_outbound_post',
        payload: { shape: 'humor' }, status: 'applied',
      });
    }
    writeLine('x-approvals.jsonl', {
      id: 'p-rej', ts: baseTs, kind: 'x_outbound_post',
      payload: { shape: 'opinion' }, status: 'rejected',
    });
    for (let i = 0; i < 2; i++) {
      writeLine('x-approvals.jsonl', { id: `r${i}`, ts: baseTs, kind: 'reply', status: 'applied' });
    }
    for (let i = 0; i < 2; i++) {
      writeLine('x-approvals.jsonl', { id: `k${i}`, ts: baseTs, kind: 'knowledge_upload', status: 'applied' });
    }

    const ev = computeEvidence(ledgerDir, 'default', nowIso);
    expect(ev.approvals_counted).toBe(8);
    // Only outbound + reply count toward dispatch. 3 applied + 1 rejected = 4 resolved; success 3/4.
    // Plus 2 replies applied = 5 applied outbound total. Resolved = 6 (5 applied, 1 rejected). Success 5/6 ≈ 0.833.
    expect(ev.dispatch_success_rate).toBeCloseTo(5 / 6, 3);
    expect(ev.shape_distribution.humor).toBe(3);
    expect(ev.shape_distribution.opinion).toBe(1);
    expect(ev.shape_distribution.reply).toBe(2);
    expect(ev.shape_distribution.upload).toBe(2);
  });

  it('ignores approvals older than the 48h lookback', () => {
    const old = new Date('2026-04-13T00:00:00Z').toISOString(); // > 48h before nowIso
    const fresh = new Date('2026-04-15T22:00:00Z').toISOString();
    writeLine('x-approvals.jsonl', { id: 'old', ts: old, kind: 'x_outbound_post', status: 'applied' });
    writeLine('x-approvals.jsonl', { id: 'new', ts: fresh, kind: 'x_outbound_post', status: 'applied' });

    const ev = computeEvidence(ledgerDir, 'default', nowIso);
    expect(ev.approvals_counted).toBe(1);
  });

  it('collects engagement median + top buckets from today\'s posts jsonl', () => {
    const rows = [
      { permalink: 'a', bucket: 'advancements', likes: 100, replies: 5, first_seen_ts: new Date(nowIso - 3600_000).toISOString() },
      { permalink: 'b', bucket: 'advancements', likes: 200, replies: 3, first_seen_ts: new Date(nowIso - 7200_000).toISOString() },
      { permalink: 'c', bucket: 'market_signal', likes: 50, replies: 1, first_seen_ts: new Date(nowIso - 7200_000).toISOString() },
    ];
    for (const r of rows) writeLine(`x-posts-${today}.jsonl`, r);

    const ev = computeEvidence(ledgerDir, 'default', nowIso);
    expect(ev.posts_24h).toBe(3);
    expect(ev.engagement_median_likes).toBe(100);
    expect(ev.engagement_median_replies).toBe(3);
    expect(ev.top_buckets[0]).toEqual({ bucket: 'advancements', count: 2 });
  });

  it('reads x-intel-last-run.json and computes intel age + ok flag', () => {
    writeFile('x-intel-last-run.json', JSON.stringify({
      ts: new Date(nowIso - 3 * 3600_000).toISOString(),
      exitCode: 0,
      durationMs: 300_000,
    }));
    const ev = computeEvidence(ledgerDir, 'default', nowIso);
    expect(ev.intel_last_run_ok).toBe(true);
    expect(ev.intel_last_run_age_hours).toBeCloseTo(3, 1);
  });

  it('notes missing intel run when the file is absent', () => {
    const ev = computeEvidence(ledgerDir, 'default', nowIso);
    expect(ev.intel_last_run_ts).toBeNull();
    expect(ev.notes).toContain('intel-last-run missing');
  });
});

describe('XOpsObserverExperiment.judge', () => {
  const exp = new XOpsObserverExperiment('/nonexistent');

  function evBuilder(overrides: Partial<XOpsObserverEvidence>): XOpsObserverEvidence {
    return {
      workspace_slug: 'default',
      ledger_dir: '/tmp',
      posts_24h: 10,
      approvals_counted: 30,
      approvals_by_status: {},
      approvals_by_kind: {},
      shape_distribution: {},
      dispatch_success_rate: 0.95,
      approval_ratio: 0.9,
      top_buckets: [],
      engagement_median_likes: 50,
      engagement_median_replies: 2,
      intel_last_run_ts: new Date().toISOString(),
      intel_last_run_ok: true,
      intel_last_run_age_hours: 1,
      stale_since_hours: 1,
      notes: [],
      ...overrides,
    };
  }

  it('passes on healthy state', () => {
    const result = { subject: null, summary: '', evidence: evBuilder({}) };
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('warns when intel last run is between 6 and 24 hours old', () => {
    const result = { subject: null, summary: '', evidence: evBuilder({ intel_last_run_age_hours: 12 }) };
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('fails when intel last run is older than 24 hours', () => {
    const result = { subject: null, summary: '', evidence: evBuilder({ intel_last_run_age_hours: 48 }) };
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('fails on catastrophic dispatch failure', () => {
    const result = { subject: null, summary: '', evidence: evBuilder({ dispatch_success_rate: 0.3 }) };
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('warns on borderline dispatch success', () => {
    const result = { subject: null, summary: '', evidence: evBuilder({ dispatch_success_rate: 0.8 }) };
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('ignores missing dispatch rate (below sample threshold)', () => {
    const result = { subject: null, summary: '', evidence: evBuilder({ dispatch_success_rate: null }) };
    expect(exp.judge(result, [])).toBe('pass');
  });
});

describe('XOpsObserverExperiment.probe', () => {
  it('emits the summary + evidence shape expected by downstream layers', async () => {
    writeLine('x-approvals.jsonl', {
      id: 'p1',
      ts: new Date(nowIso - 3600_000).toISOString(),
      kind: 'x_outbound_post',
      payload: { shape: 'humor' },
      status: 'applied',
    });
    writeFile('x-intel-last-run.json', JSON.stringify({ ts: new Date(nowIso - 1800_000).toISOString(), exitCode: 0 }));

    const exp = new XOpsObserverExperiment(ledgerDir);
    const result = await exp.probe(makeCtx('default'));
    expect(result.subject).toBe('x-ops:summary');
    const ev = result.evidence as XOpsObserverEvidence;
    expect(ev.approvals_counted).toBeGreaterThan(0);
    expect(ev.workspace_slug).toBe('default');
  });
});
