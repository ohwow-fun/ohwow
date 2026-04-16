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

  it('templates carry no em-dash (regression guard after manual heal)', async () => {
    // The x_reply and email templates were healed manually because
    // patch-author's string-literal mode could not find the em-dash:
    // source stores \u2014 as a six-char escape, the probe sees the
    // one-char runtime output. This guard prevents re-introduction.
    const r = await exp.probe(stubCtx);
    const ev = r.evidence as OutreachCopyFuzzEvidence;
    const emDashHit = ev.violations.find((v) => v.ruleId === 'no-em-dash');
    expect(emDashHit).toBeUndefined();
  });

  it('clean templates produce a pass verdict', async () => {
    const r = await exp.probe(stubCtx);
    const verdict = exp.judge(r, []);
    expect(verdict).toBe('pass');
  });

  it('templates contain no pitch CTAs (outreach is conversational, not sales)', async () => {
    const r = await exp.probe(stubCtx);
    const ev = r.evidence as OutreachCopyFuzzEvidence;
    const pitchHit = ev.violations.find((v) => v.ruleId === 'no-pitch-cta');
    expect(pitchHit).toBeUndefined();
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
