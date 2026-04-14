import { describe, it, expect } from 'vitest';
import { HandlerSchemaDriftExperiment } from '../experiments/handler-schema-drift.js';
import type { Experiment, ExperimentContext, ProbeResult } from '../experiment-types.js';

/**
 * The probe reads the real tool registry + tool-definitions at
 * module load via a self-computed REPO_ROOT. These tests don't fake
 * the filesystem — the probe either finds the registry (dev daemon,
 * source tree on disk) or short-circuits with skip_reason. Either
 * shape is acceptable; we just assert the result is well-formed and
 * the judge maps severity to verdict correctly.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopCtx: ExperimentContext = { db: {} as any, workspaceId: 'ws-drift', engine: {} as any, recentFindings: async () => [] };

describe('HandlerSchemaDriftExperiment', () => {
  const exp: Experiment = new HandlerSchemaDriftExperiment();

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
        total: 0, clean: 0, minor: 0, major: 0, skipped: 0,
        majors: [], minors: [], unresolved: [], missing_schemas: [],
        skip_reason: 'registry source not readable',
      },
    };
    expect(exp.judge(skip, [])).toBe('pass');
  });

  it('judge transitions on synthetic evidence: 0 major + 0 minor → pass, minor → warning, major → fail', () => {
    const base = {
      total: 10, clean: 10, skipped: 0,
      majors: [], minors: [], unresolved: [], missing_schemas: [],
      skip_reason: null,
    } as const;

    const pass: ProbeResult = {
      subject: null,
      summary: 'all clean',
      evidence: { ...base, clean: 10, minor: 0, major: 0 },
    };
    expect(exp.judge(pass, [])).toBe('pass');

    const warn: ProbeResult = {
      subject: 'handler:foo',
      summary: '1 minor',
      evidence: { ...base, clean: 9, minor: 1, major: 0, minors: [{ tool: 'foo', verdict: 'MINOR: …' }] },
    };
    expect(exp.judge(warn, [])).toBe('warning');

    const fail: ProbeResult = {
      subject: 'handler:bar',
      summary: '1 major',
      evidence: {
        ...base,
        clean: 9, minor: 0, major: 1,
        majors: [{ tool: 'bar', required_not_read: ['x'], verdict: 'MAJOR: bar — REQUIRED-NOT-READ: x' }],
      },
    };
    expect(exp.judge(fail, [])).toBe('fail');
  });

  it('no intervene method exists (pure observation)', () => {
    expect(exp.intervene).toBeUndefined();
  });
});
