import { describe, it, expect } from 'vitest';
import { proposedTestPath, TestCoverageProbeExperiment, type TestCoverageEvidence } from '../experiments/test-coverage-probe.js';
import type { ProbeResult } from '../experiment-types.js';

function probe(ev: TestCoverageEvidence): ProbeResult {
  return { subject: 'meta:test-coverage', summary: '', evidence: ev };
}

function evidence(over: Partial<TestCoverageEvidence> = {}): TestCoverageEvidence {
  return {
    affected_files: [],
    scanned_tier2_files: 0,
    missing_tests: [],
    ...over,
  };
}

describe('proposedTestPath', () => {
  it('routes self-bench experiment sources into src/self-bench/__tests__/', () => {
    expect(proposedTestPath('src/self-bench/experiments/foo.ts')).toBe(
      'src/self-bench/__tests__/foo.test.ts',
    );
  });

  it('colocates __tests__ next to other tier-2 sources', () => {
    expect(proposedTestPath('src/lib/format-duration.ts')).toBe(
      'src/lib/__tests__/format-duration.test.ts',
    );
  });
});

describe('TestCoverageProbeExperiment.judge', () => {
  const exp = new TestCoverageProbeExperiment();

  it('passes when nothing is missing', () => {
    expect(exp.judge(probe(evidence({ scanned_tier2_files: 5 })), [])).toBe('pass');
  });

  it('warns when any tier-2 source lacks a sibling test', () => {
    expect(
      exp.judge(
        probe(
          evidence({
            scanned_tier2_files: 5,
            missing_tests: [
              { sourceFile: 'src/lib/x.ts', proposedTestPath: 'src/lib/__tests__/x.test.ts' },
            ],
            affected_files: ['src/lib/__tests__/x.test.ts'],
          }),
        ),
        [],
      ),
    ).toBe('warning');
  });
});
