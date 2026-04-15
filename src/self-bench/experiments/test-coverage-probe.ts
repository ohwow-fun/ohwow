/**
 * TestCoverageProbeExperiment — flags tier-2 source files that lack a
 * sibling vitest suite.
 *
 * Every tier-2 `.ts` path in path-trust-tiers should have a companion
 * under `src/self-bench/__tests__/<name>.test.ts` (for self-bench
 * sources) or `<dir>/__tests__/<name>.test.ts` (for other tier-2
 * helpers). When it doesn't, the probe emits a warning finding whose
 * affected_files lists the proposed new test path. Because that path
 * is under a tier-1 new-file-allowed prefix, the authoring pipeline
 * can create the file without additional trust escalation.
 *
 * Observe-only (no intervene). Cadence default 60min.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { getSelfCommitStatus } from '../self-commit.js';
import { getAllowedPrefixes } from '../path-trust-tiers.js';

export interface MissingTestCoverage {
  sourceFile: string;
  proposedTestPath: string;
}

export interface TestCoverageEvidence extends Record<string, unknown> {
  affected_files: string[];
  scanned_tier2_files: number;
  missing_tests: MissingTestCoverage[];
}

export class TestCoverageProbeExperiment implements Experiment {
  readonly id = 'test-coverage-probe';
  readonly name = 'Tier-2 test coverage';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'Every tier-2 TypeScript source should have a sibling vitest suite. ' +
    'Surfacing gaps as findings lets the author pipeline propose new ' +
    'tier-1 test files to close them.';
  readonly cadence = { everyMs: 60 * 60 * 1000, runOnBoot: false };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const { repoRoot } = getSelfCommitStatus();
    if (!repoRoot) {
      return {
        subject: 'meta:test-coverage',
        summary: 'no repo root configured',
        evidence: emptyEvidence(),
      };
    }
    const allowed = getAllowedPrefixes();
    const tier2Sources: string[] = [];
    for (const prefix of allowed) {
      if (!prefix.endsWith('.ts') && !prefix.endsWith('.tsx')) continue;
      if (prefix.includes('/__tests__/')) continue;
      const abs = path.join(repoRoot, prefix);
      if (fs.existsSync(abs)) tier2Sources.push(prefix);
    }

    const missing: MissingTestCoverage[] = [];
    for (const src of tier2Sources) {
      const proposed = proposedTestPath(src);
      const absTest = path.join(repoRoot, proposed);
      if (!fs.existsSync(absTest)) {
        missing.push({ sourceFile: src, proposedTestPath: proposed });
      }
    }

    const evidence: TestCoverageEvidence = {
      affected_files: missing.map((m) => m.proposedTestPath),
      scanned_tier2_files: tier2Sources.length,
      missing_tests: missing,
    };
    const summary =
      missing.length === 0
        ? `${tier2Sources.length} tier-2 source(s), all have sibling tests`
        : `${missing.length} tier-2 source(s) missing tests`;
    return { subject: 'meta:test-coverage', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as TestCoverageEvidence;
    return ev.missing_tests.length === 0 ? 'pass' : 'warning';
  }
}

export function proposedTestPath(sourceRel: string): string {
  const parsed = path.posix.parse(sourceRel.replace(/\\/g, '/'));
  const base = `${parsed.name}.test.ts`;
  if (parsed.dir.startsWith('src/self-bench/experiments')) {
    return `src/self-bench/__tests__/${base}`;
  }
  const testsDir = `${parsed.dir}/__tests__`;
  return `${testsDir}/${base}`;
}

function emptyEvidence(): TestCoverageEvidence {
  return {
    affected_files: [],
    scanned_tier2_files: 0,
    missing_tests: [],
  };
}
