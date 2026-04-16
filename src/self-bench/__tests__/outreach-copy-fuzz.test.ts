import { describe, it, expect } from 'vitest';
import { OutreachCopyFuzzExperiment, type OutreachCopyFuzzEvidence } from '../experiments/outreach-copy-fuzz.js';
import type { ExperimentContext } from '../experiment-types.js';

const stubCtx = {} as unknown as ExperimentContext;

describe('OutreachCopyFuzzExperiment', () => {
  const exp = new OutreachCopyFuzzExperiment();

  it('emits affected_files pointing at outreach-thermostat.ts (tier-2 target)', async () => {
    const r = await exp.probe(stubCtx);
    const ev = r.evidence as OutreachCopyFuzzEvidence;
    expect(ev.affected_files).toEqual(['src/self-bench/experiments/outreach-thermostat.ts']);
  });

  it('runs at least one check per channel (x_dm + x_reply + email)', async () => {
    const r = await exp.probe(stubCtx);
    const ev = r.evidence as OutreachCopyFuzzEvidence;
    // 3 channels × 1 text check + 1 email subject check
    expect(ev.checks_run).toBeGreaterThanOrEqual(4);
    expect(ev.samples.map((s) => s.channel)).toEqual(['x_dm', 'x_reply', 'email']);
  });

  it('flags the em-dash currently present in the x_reply template', async () => {
    // The existing template 'running everything local' string uses a
    // \u2014 em-dash. This assertion is the regression guard for our
    // Phase 2 wiring — if someone rewrites the templates to drop the
    // em-dash BEFORE the patch-author does, this test will need to
    // be updated (intentional, signals the heal happened).
    const r = await exp.probe(stubCtx);
    const ev = r.evidence as OutreachCopyFuzzEvidence;
    const emDashHit = ev.violations.find((v) => v.ruleId === 'no-em-dash');
    expect(emDashHit).toBeDefined();
    expect(emDashHit?.channel).toBe('x_reply');
  });

  it('verdict is warning when any invariant fails', async () => {
    const r = await exp.probe(stubCtx);
    const verdict = exp.judge(r, []);
    expect(['warning', 'fail']).toContain(verdict);
  });

  it('every violation carries a ruleId (so evidenceLiteralsAppearInSource accepts the short em-dash)', async () => {
    const r = await exp.probe(stubCtx);
    const ev = r.evidence as OutreachCopyFuzzEvidence;
    for (const v of ev.violations) {
      expect(typeof v.ruleId).toBe('string');
      expect(v.ruleId.length).toBeGreaterThan(0);
    }
  });
});
