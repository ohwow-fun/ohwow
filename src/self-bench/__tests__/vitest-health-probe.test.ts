import { describe, it, expect } from 'vitest';
import {
  VitestHealthProbeExperiment,
  parseFailingFiles,
  parseVitestSummary,
  type VitestHealthEvidence,
} from '../experiments/vitest-health-probe.js';
import type { ProbeResult } from '../experiment-types.js';

function probe(ev: VitestHealthEvidence): ProbeResult {
  return { subject: 'meta:vitest', summary: '', evidence: ev };
}

function evidence(over: Partial<VitestHealthEvidence> = {}): VitestHealthEvidence {
  return {
    affected_files: [],
    total_tests: 0,
    passed_tests: 0,
    failed_tests: 0,
    failing_files: [],
    runner_error: null,
    test_glob: 'src/**/*.test.ts',
    ...over,
  };
}

describe('VitestHealthProbeExperiment.judge', () => {
  const exp = new VitestHealthProbeExperiment();

  it('passes when all tests pass', () => {
    expect(
      exp.judge(probe(evidence({ total_tests: 10, passed_tests: 10 })), []),
    ).toBe('pass');
  });

  it('fails when any test fails', () => {
    expect(
      exp.judge(
        probe(
          evidence({
            total_tests: 10,
            passed_tests: 9,
            failed_tests: 1,
            failing_files: [{ testFile: 'src/a.test.ts', failedAssertions: 1, firstMessage: null }],
          }),
        ),
        [],
      ),
    ).toBe('fail');
  });

  it('warns when the runner errored before collecting any tests', () => {
    expect(
      exp.judge(probe(evidence({ runner_error: 'timeout' })), []),
    ).toBe('warning');
  });
});

describe('parseVitestSummary', () => {
  it('skips preceding pino log objects and finds the reporter summary', () => {
    const noisy =
      '{"level":30,"msg":"[runner] registered experiment","experimentId":"x"}\n' +
      '{"level":30,"msg":"another log line"}\n' +
      '{"numTotalTestSuites":2,"numTotalTests":5,"numPassedTests":4,"numFailedTests":1,"testResults":[]}';
    const parsed = parseVitestSummary(noisy);
    expect(parsed).not.toBeNull();
    expect(parsed!.numTotalTests).toBe(5);
    expect(parsed!.numFailedTests).toBe(1);
  });

  it('returns null when no vitest summary is present', () => {
    expect(parseVitestSummary('{"level":30,"msg":"only logs"}')).toBeNull();
    expect(parseVitestSummary('')).toBeNull();
  });
});

describe('parseFailingFiles', () => {
  it('extracts failing test file paths + first failure message', () => {
    const repoRoot = '/repo';
    const summary = {
      testResults: [
        {
          name: '/repo/src/ok.test.ts',
          status: 'passed',
          assertionResults: [{ status: 'passed' }],
        },
        {
          name: '/repo/src/bad.test.ts',
          status: 'failed',
          assertionResults: [
            { status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2\n at foo'] },
            { status: 'passed' },
          ],
        },
      ],
    };
    const failing = parseFailingFiles(summary, repoRoot);
    expect(failing).toHaveLength(1);
    expect(failing[0].testFile).toBe('src/bad.test.ts');
    expect(failing[0].failedAssertions).toBe(1);
    expect(failing[0].firstMessage).toContain('AssertionError');
  });

  it('drops entries whose name is absolute-out-of-repo', () => {
    const failing = parseFailingFiles(
      { testResults: [{ name: '/other/elsewhere.test.ts', status: 'failed' }] },
      '/repo',
    );
    expect(failing).toEqual([]);
  });
});
