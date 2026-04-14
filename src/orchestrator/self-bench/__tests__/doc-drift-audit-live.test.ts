/**
 * Live doc-vs-code drift audit against the real repo.
 *
 * Runs the full DRIFT_CLAIMS set against a context rooted at the
 * repo root, prints a severity-tagged report, asserts zero major
 * findings. Minor findings are printed but don't fail the test —
 * they're design drift to clean up in a follow-up commit, not
 * reasons to stop the bench.
 *
 * Skipped by default. Set OHWOW_BENCH_LIVE=1 to run:
 *
 *   OHWOW_BENCH_LIVE=1 npx vitest run src/orchestrator/self-bench/__tests__/doc-drift-audit-live.test.ts
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

import { runDriftAudit, formatDriftReport, createDriftCtx } from '../doc-drift-audit.js';
import { DRIFT_CLAIMS } from '../drift-claims.js';

const LIVE = process.env.OHWOW_BENCH_LIVE === '1';

describe.skipIf(!LIVE)('doc-vs-code drift audit against the live repo', () => {
  it('every major invariant still holds', () => {
    const repoRoot = resolve(__dirname, '../../../..');
    const ctx = createDriftCtx(repoRoot);

    const run = runDriftAudit(DRIFT_CLAIMS, ctx);

    // eslint-disable-next-line no-console
    console.log('\n' + formatDriftReport(run) + '\n');
    // eslint-disable-next-line no-console
    console.log(
      `[drift summary] total=${run.summary.total} clean=${run.summary.clean} ` +
      `minor=${run.summary.minor} major=${run.summary.major}\n`,
    );

    // Assert on major only. Minor findings are visible in the
    // report and tracked for follow-up cleanup commits.
    expect(
      run.summary.major,
      `doc-drift audit found ${run.summary.major} major drift(s). See report above.`,
    ).toBe(0);
  });
});
