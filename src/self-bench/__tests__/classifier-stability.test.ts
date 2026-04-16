import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClassifierStabilityExperiment } from '../experiments/classifier-stability.js';
import type { ExperimentContext } from '../experiment-types.js';

const TEST_SLUG = `classifier-stability-test-${Date.now()}`;
const DIR = path.join(os.homedir(), '.ohwow', 'workspaces', TEST_SLUG);
const LOG = path.join(DIR, 'x-authors-classifier-log.jsonl');

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

function writeLog(rows: Array<Record<string, unknown>>): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(
    LOG,
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
}

const nowIso = () => new Date().toISOString();
const isoMinutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000).toISOString();

beforeEach(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

afterEach(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('ClassifierStabilityExperiment', () => {
  it('passes when log is missing (first boot)', async () => {
    const exp = new ClassifierStabilityExperiment({ allowedWorkspace: TEST_SLUG });
    const res = await exp.probe(ctx(buildDb()));
    const ev = res.evidence as { log_rows_in_window: number; handles_with_multi_runs: number };
    expect(ev.log_rows_in_window).toBe(0);
    expect(ev.handles_with_multi_runs).toBe(0);
    expect(exp.judge(res, [])).toBe('pass');
  });

  it('passes when fewer than 5 multi-run handles (insufficient signal)', async () => {
    writeLog([
      { ts: nowIso(), handle: 'alice', intent: 'buyer_intent', confidence: 0.9, accepted: true },
      { ts: nowIso(), handle: 'alice', intent: 'builder_curiosity', confidence: 0.7, accepted: false },
      { ts: nowIso(), handle: 'bob', intent: 'buyer_intent', confidence: 0.8, accepted: true },
    ]);
    const exp = new ClassifierStabilityExperiment({ allowedWorkspace: TEST_SLUG });
    const res = await exp.probe(ctx(buildDb()));
    const ev = res.evidence as {
      handles_with_multi_runs: number;
      handles_accept_flipped: number;
    };
    expect(ev.handles_with_multi_runs).toBe(1);
    // alice flipped but we don't have enough multi-run handles
    expect(ev.handles_accept_flipped).toBe(1);
    expect(exp.judge(res, [])).toBe('pass');
    expect(res.summary).toMatch(/need ≥5/);
  });

  it('warns when any handle flipped accept verdict with enough multi-run signal', async () => {
    // 5 multi-run handles; only one of them flipped accept — should warn.
    const rows = [
      { ts: nowIso(), handle: 'alice', intent: 'buyer_intent', confidence: 0.9, accepted: true },
      { ts: nowIso(), handle: 'alice', intent: 'builder_curiosity', confidence: 0.7, accepted: false },
      { ts: nowIso(), handle: 'bob', intent: 'adjacent_noise', confidence: 0.8, accepted: false },
      { ts: nowIso(), handle: 'bob', intent: 'adjacent_noise', confidence: 0.85, accepted: false },
      { ts: nowIso(), handle: 'carol', intent: 'buyer_intent', confidence: 0.9, accepted: true },
      { ts: nowIso(), handle: 'carol', intent: 'buyer_intent', confidence: 0.88, accepted: true },
      { ts: nowIso(), handle: 'dave', intent: 'builder_curiosity', confidence: 0.7, accepted: false },
      { ts: nowIso(), handle: 'dave', intent: 'builder_curiosity', confidence: 0.75, accepted: false },
      { ts: nowIso(), handle: 'eve', intent: 'adjacent_noise', confidence: 0.9, accepted: false },
      { ts: nowIso(), handle: 'eve', intent: 'adjacent_noise', confidence: 0.8, accepted: false },
    ];
    writeLog(rows);
    const exp = new ClassifierStabilityExperiment({ allowedWorkspace: TEST_SLUG });
    const res = await exp.probe(ctx(buildDb()));
    const ev = res.evidence as {
      handles_with_multi_runs: number;
      handles_accept_flipped: number;
      accept_flip_rate: number;
      top_offenders: Array<{ handle: string; accept_flipped: boolean }>;
    };
    expect(ev.handles_with_multi_runs).toBe(5);
    expect(ev.handles_accept_flipped).toBe(1);
    expect(ev.accept_flip_rate).toBe(0.2);
    expect(ev.top_offenders[0].handle).toBe('alice');
    expect(ev.top_offenders[0].accept_flipped).toBe(true);
    expect(exp.judge(res, [])).toBe('warning');
  });

  it('passes when enough multi-run handles but none flipped accept', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => {
      const handle = `handle${i}`;
      return [
        { ts: nowIso(), handle, intent: 'adjacent_noise', confidence: 0.9, accepted: false },
        { ts: nowIso(), handle, intent: 'adjacent_noise', confidence: 0.85, accepted: false },
      ];
    }).flat();
    writeLog(rows);
    const exp = new ClassifierStabilityExperiment({ allowedWorkspace: TEST_SLUG });
    const res = await exp.probe(ctx(buildDb()));
    const ev = res.evidence as {
      handles_with_multi_runs: number;
      handles_accept_flipped: number;
    };
    expect(ev.handles_with_multi_runs).toBe(5);
    expect(ev.handles_accept_flipped).toBe(0);
    expect(exp.judge(res, [])).toBe('pass');
    expect(res.summary).toMatch(/classifier stable/);
  });

  it('excludes rows outside the 14d lookback window', async () => {
    const oldIso = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    writeLog([
      { ts: oldIso, handle: 'alice', intent: 'buyer_intent', confidence: 0.9, accepted: true },
      { ts: oldIso, handle: 'alice', intent: 'builder_curiosity', confidence: 0.7, accepted: false },
      { ts: nowIso(), handle: 'bob', intent: 'adjacent_noise', confidence: 0.9, accepted: false },
    ]);
    const exp = new ClassifierStabilityExperiment({ allowedWorkspace: TEST_SLUG });
    const res = await exp.probe(ctx(buildDb()));
    const ev = res.evidence as { log_rows_in_window: number; handles_total: number };
    expect(ev.log_rows_in_window).toBe(1);
    expect(ev.handles_total).toBe(1);
  });

  it('treats classify_error rows as runs for bookkeeping but not for flip detection', async () => {
    writeLog([
      { ts: nowIso(), handle: 'alice', intent: 'buyer_intent', confidence: 0.9, accepted: true },
      { ts: nowIso(), handle: 'alice', intent: null, confidence: null, accepted: false, classify_error: 'parse failed' },
    ]);
    const exp = new ClassifierStabilityExperiment({ allowedWorkspace: TEST_SLUG });
    const res = await exp.probe(ctx(buildDb()));
    const ev = res.evidence as {
      handles_with_multi_runs: number;
      handles_accept_flipped: number;
    };
    expect(ev.handles_with_multi_runs).toBe(1);
    // classify_error row is excluded from verdict set, so alice has
    // only one real verdict (accepted=true) → no flip detected.
    expect(ev.handles_accept_flipped).toBe(0);
  });

  it('tolerates malformed JSONL lines without crashing', async () => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(LOG, '{"handle":"ok","ts":"' + nowIso() + '","accepted":true}\nnot-json\n', 'utf-8');
    const exp = new ClassifierStabilityExperiment({ allowedWorkspace: TEST_SLUG });
    const res = await exp.probe(ctx(buildDb()));
    const ev = res.evidence as { log_rows_in_window: number };
    expect(ev.log_rows_in_window).toBe(1);
  });

  it('skips when workspace slug does not match allowedWorkspace', async () => {
    const exp = new ClassifierStabilityExperiment({ allowedWorkspace: 'different-slug' });
    const res = await exp.probe(ctx(buildDb()));
    expect(res.summary).toMatch(/skipped/);
    expect(exp.judge(res, [])).toBe('pass');
  });
});
