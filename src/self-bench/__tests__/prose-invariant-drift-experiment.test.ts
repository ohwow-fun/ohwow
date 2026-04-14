import { describe, it, expect } from 'vitest';
import { ProseInvariantDriftExperiment } from '../experiments/prose-invariant-drift.js';
import type { Experiment, ExperimentContext, ProbeResult } from '../experiment-types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopCtx: ExperimentContext = { db: {} as any, workspaceId: 'ws-prose', engine: {} as any, recentFindings: async () => [] };

describe('ProseInvariantDriftExperiment', () => {
  const exp: Experiment = new ProseInvariantDriftExperiment();

  it('probe returns a well-formed ProbeResult against the live repo', async () => {
    const result = await exp.probe(noopCtx);
    const ev = result.evidence as Record<string, unknown>;
    expect(typeof ev.total).toBe('number');
    expect(typeof ev.clean).toBe('number');
    expect(typeof ev.minor).toBe('number');
    expect(typeof ev.major).toBe('number');
    expect(Array.isArray(ev.majors)).toBe(true);
    expect(Array.isArray(ev.minors)).toBe(true);
    expect('skip_reason' in ev).toBe(true);
    expect(typeof result.summary).toBe('string');
  });

  it('judge returns pass when skip_reason is set', () => {
    const skip: ProbeResult = {
      subject: null,
      summary: 'skipped',
      evidence: {
        total: 0, clean: 0, minor: 0, major: 0,
        majors: [], minors: [],
        skip_reason: 'CLAUDE.md not readable',
      },
    };
    expect(exp.judge(skip, [])).toBe('pass');
  });

  it('judge maps synthetic severity to verdict: clean → pass, minor → warning, major → fail', () => {
    const base = { total: 18, majors: [], minors: [], skip_reason: null } as const;

    const pass: ProbeResult = {
      subject: null,
      summary: 'all clean',
      evidence: { ...base, clean: 18, minor: 0, major: 0 },
    };
    expect(exp.judge(pass, [])).toBe('pass');

    const warn: ProbeResult = {
      subject: 'claim:minor-one',
      summary: '1 minor',
      evidence: {
        ...base,
        clean: 17, minor: 1, major: 0,
        minors: [{ id: 'minor-one', source: 'doc', verdict: 'MINOR: …' }],
      },
    };
    expect(exp.judge(warn, [])).toBe('warning');

    const fail: ProbeResult = {
      subject: 'claim:major-one',
      summary: '1 major',
      evidence: {
        ...base,
        clean: 17, minor: 0, major: 1,
        majors: [{ id: 'major-one', source: 'CLAUDE.md', verdict: 'MAJOR: …', evidence: [] }],
      },
    };
    expect(exp.judge(fail, [])).toBe('fail');
  });

  it('no intervene method exists (pure observation)', () => {
    expect(exp.intervene).toBeUndefined();
  });
});
