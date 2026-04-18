/**
 * Vitest wrapper around the autonomy evaluation harness.
 *
 * Drives `runAllScenarios()` and asserts no failures. CI catches
 * transcript drift automatically: any change to the conductor / ranker
 * / director / phase orchestrator that shifts a scenario's behavior
 * fails this test until the maintainer regenerates goldens via
 *   npm run autonomy:eval:update
 * and reviews the diff.
 *
 * The harness budget is 15s for the whole suite; we set the test
 * timeout slightly above that to leave headroom for cold starts on
 * slower CI runners.
 */
import { describe, it, expect } from 'vitest';
import { runAllScenarios } from '../harness.js';

describe('autonomy eval harness', () => {
  it('all scenarios match their golden transcripts and assertions pass', async () => {
    const result = await runAllScenarios();
    if (result.fail.length > 0) {
      const summary = result.fail
        .map(
          (f) =>
            `  - ${f.name}: ${f.reason}${f.diff ? `\n${f.diff.split('\n').map((l) => `      ${l}`).join('\n')}` : ''}`,
        )
        .join('\n');
      throw new Error(
        `autonomy eval failed (${result.fail.length}/${result.pass.length + result.fail.length}):\n${summary}\n\nRegenerate goldens with: npm run autonomy:eval:update`,
      );
    }
    expect(result.fail).toHaveLength(0);
    // Sanity: at least the canonical 12 scenarios should be discovered.
    expect(result.pass.length).toBeGreaterThanOrEqual(12);
  }, 30_000);
});
