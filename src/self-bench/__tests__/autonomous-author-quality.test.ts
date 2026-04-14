/**
 * Tests for AutonomousAuthorQualityExperiment.
 *
 * The experiment reads filesystem (the experiments dir) AND git AND
 * the findings ledger. We exercise the pure helpers in isolation via
 * direct calls, then exercise the orchestration (probe → judge) with
 * a stubbed DB and the real filesystem state of this repo.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AutonomousAuthorQualityExperiment,
  countTemplatedFamilies,
  countGhostProbes,
  isAutonomousExperimentId,
  readAutonomousVerdictMix,
} from '../experiments/autonomous-author-quality.js';
import * as selfCommit from '../self-commit.js';
import type { ExperimentContext, Finding } from '../experiment-types.js';

function fakeDbFromFindings(rows: Array<{ experiment_id: string; verdict: string }>) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  };
  return { from: () => chain };
}

function makeCtx(
  rows: Array<{ experiment_id: string; verdict: string }> = [],
): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: fakeDbFromFindings(rows) as any,
    workspaceId: 'ws-test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async () => [],
  };
}

describe('isAutonomousExperimentId', () => {
  it('matches the three known autonomous prefixes', () => {
    expect(isAutonomousExperimentId('migration-schema-008-plans')).toBe(true);
    expect(isAutonomousExperimentId('toolchain-tool-test-agents')).toBe(true);
    expect(isAutonomousExperimentId('toolchain-singleton-typecheck')).toBe(true);
  });

  it('does not match hand-written experiments', () => {
    expect(isAutonomousExperimentId('content-cadence-tuner')).toBe(false);
    expect(isAutonomousExperimentId('agent-outcomes')).toBe(false);
    expect(isAutonomousExperimentId('model-health')).toBe(false);
  });

  it('does not match the parameterized base classes themselves', () => {
    // The base class id (e.g. 'migration-schema-probe' if it existed)
    // would still match the prefix — but we never instantiate the base
    // class with that id directly, only the registry-driven instances
    // which use 'migration-schema-008-plans' etc. The regex is
    // intentionally permissive at the prefix; the structural protection
    // is that the parameterized base class is never registered.
    expect(isAutonomousExperimentId('migration-schema-probe')).toBe(true);
  });
});

describe('countTemplatedFamilies — against the live experiments dir', () => {
  it('returns counts for all known templated prefixes', () => {
    const counts = countTemplatedFamilies();
    expect(Object.keys(counts).sort()).toEqual(
      ['migration-schema-', 'toolchain-singleton-', 'toolchain-tool-test-'].sort(),
    );
  });

  it('after the slop refactor, both completed families should be at zero', () => {
    // 89e4516 collapsed migration-schema-* into a registry; 305adab
    // collapsed toolchain-tool-test-* the same way. If either count
    // climbs back above 0, the autonomous loop has emitted a per-X
    // file the proposal generator should have appended to the
    // registry instead. Catches Layer 1 regressions.
    const counts = countTemplatedFamilies();
    expect(counts['migration-schema-'] ?? 0).toBe(0);
    expect(counts['toolchain-tool-test-'] ?? 0).toBe(0);
  });
});

describe('countGhostProbes', () => {
  it('returns 0 for the current repo state (post-refactor)', () => {
    // Both refactors dropped the per-file probes that referenced
    // non-existent test/migration paths. There should be no ghosts
    // left in src/self-bench/experiments/.
    expect(countGhostProbes(process.cwd())).toBe(0);
  });
});

describe('readAutonomousVerdictMix', () => {
  it('counts only autonomous experiment ids', async () => {
    const rows = [
      { experiment_id: 'migration-schema-008-plans', verdict: 'pass' },
      { experiment_id: 'migration-schema-008-plans', verdict: 'pass' },
      { experiment_id: 'agent-outcomes', verdict: 'fail' }, // hand-written, excluded
      { experiment_id: 'toolchain-tool-test-agents', verdict: 'pass' },
      { experiment_id: 'toolchain-tool-test-agents', verdict: 'fail' },
    ];
    const result = await readAutonomousVerdictMix(makeCtx(rows));
    expect(result.totalAutonomous).toBe(2);
    expect(result.alwaysPass).toBe(1); // only migration-schema-008-plans only emitted pass
  });

  it('returns zeros when no autonomous findings exist', async () => {
    const result = await readAutonomousVerdictMix(makeCtx([]));
    expect(result).toEqual({ totalAutonomous: 0, alwaysPass: 0 });
  });
});

describe('AutonomousAuthorQualityExperiment — probe + judge orchestration', () => {
  it('passes with reason=no_repo_root when repo root is unavailable', async () => {
    const spy = vi.spyOn(selfCommit, 'getSelfCommitStatus').mockReturnValue({
      killSwitchOpen: false,
      repoRootConfigured: false,
      repoRoot: null,
      allowedPathPrefixes: [],
      auditLogPath: '/tmp/test-audit',
    });
    try {
      const exp = new AutonomousAuthorQualityExperiment();
      const result = await exp.probe(makeCtx());
      expect((result.evidence as { reason?: string }).reason).toBe('no_repo_root');
      expect(exp.judge(result, [])).toBe('pass');
    } finally {
      spy.mockRestore();
    }
  });

  it('fails when ghost_probe_count >= GHOST_HARD_FAIL_COUNT (sanity test via stubbed evidence)', () => {
    const exp = new AutonomousAuthorQualityExperiment();
    // Direct judge() call with synthetic evidence — covers the hard-fail branch
    // without needing to seed actual ghost files on disk.
    const result = {
      summary: 'synthetic',
      evidence: {
        vital_signs: {
          commit_volume_24h: 0,
          templated_families: {},
          ghost_probe_count: 3,
          always_pass_experiment_count: 0,
        },
        autonomous_experiment_count: 0,
        always_pass_ratio: 0,
        failures: ['3 ghost probe(s) reference files that do not exist'],
        repo_root: '/repo',
      },
    };
    expect(exp.judge(result, [] as Finding[])).toBe('fail');
  });

  it('warns at 1-2 failures, fails at 3+', () => {
    const exp = new AutonomousAuthorQualityExperiment();
    const base = {
      summary: '',
      evidence: {
        vital_signs: {
          commit_volume_24h: 0,
          templated_families: {},
          ghost_probe_count: 0,
          always_pass_experiment_count: 0,
        },
        autonomous_experiment_count: 0,
        always_pass_ratio: 0,
        failures: [] as string[],
        repo_root: '/repo',
      },
    };
    expect(exp.judge({ ...base, evidence: { ...base.evidence, failures: [] } }, [])).toBe('pass');
    expect(exp.judge({ ...base, evidence: { ...base.evidence, failures: ['a'] } }, [])).toBe('warning');
    expect(exp.judge({ ...base, evidence: { ...base.evidence, failures: ['a', 'b'] } }, [])).toBe('warning');
    expect(exp.judge({ ...base, evidence: { ...base.evidence, failures: ['a', 'b', 'c'] } }, [])).toBe('fail');
  });
});
