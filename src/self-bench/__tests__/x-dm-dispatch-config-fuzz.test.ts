import { describe, it, expect } from 'vitest';
import {
  XDmDispatchConfigFuzzExperiment,
  type XDmDispatchConfigFuzzEvidence,
} from '../experiments/x-dm-dispatch-config-fuzz.js';
import type { ExperimentContext } from '../experiment-types.js';

function ctx(): ExperimentContext {
  return {
    db: {} as never,
    workspaceId: 'ws-1',
    workspaceSlug: 'default',
    engine: {} as never,
    recentFindings: async () => [],
  };
}

describe('XDmDispatchConfigFuzzExperiment', () => {
  it('passes against the current x-dm-dispatch-config exports', async () => {
    const exp = new XDmDispatchConfigFuzzExperiment();
    const r = await exp.probe(ctx());
    const ev = r.evidence as XDmDispatchConfigFuzzEvidence;
    expect(exp.judge(r, [])).toBe('pass');
    expect(ev.violations).toEqual([]);
    expect(ev.affected_files).toEqual(['src/lib/x-dm-dispatch-config.ts']);
    // Current values sit comfortably inside the sane ranges.
    expect(ev.observed.interval_ms).toBeGreaterThanOrEqual(30_000);
    expect(ev.observed.interval_ms).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(ev.observed.max_per_tick).toBeGreaterThanOrEqual(1);
    expect(ev.observed.max_per_tick).toBeLessThanOrEqual(20);
  });

  it('runs a deterministic set of checks (ruleId contract)', async () => {
    // Guards against silent rule-set drift. patch-author matches on
    // ruleId literals in source to skip (finding, file-shape) shapes
    // it already reverted — a drifting rule set breaks that dedup.
    const exp = new XDmDispatchConfigFuzzExperiment();
    const r = await exp.probe(ctx());
    const ev = r.evidence as XDmDispatchConfigFuzzEvidence;
    // 3 interval rules (type/floor/ceiling) + 3 batch rules = 6.
    expect(ev.checks_run).toBe(6);
  });

  it('emits affected_files and a summary that mentions the observed values', async () => {
    // patch-author's evidence-literals-in-source check walks violation
    // message text; evidence must name the observed numbers so the
    // literal-match step has something to pin. Running on a healthy
    // config: violations are empty, but the summary text still carries
    // the observed numbers so the digest can report them.
    const exp = new XDmDispatchConfigFuzzExperiment();
    const r = await exp.probe(ctx());
    const ev = r.evidence as XDmDispatchConfigFuzzEvidence;
    expect(ev.affected_files).toEqual(['src/lib/x-dm-dispatch-config.ts']);
    expect(r.summary).toContain(String(ev.observed.interval_ms));
    expect(r.summary).toContain(String(ev.observed.max_per_tick));
  });
});
