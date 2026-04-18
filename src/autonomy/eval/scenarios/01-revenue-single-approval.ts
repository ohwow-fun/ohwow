/**
 * 01-revenue-single-approval
 *
 * Baseline revenue path: a single 6h-old approval makes the Conductor
 * open a revenue-mode arc and run ONE revenue phase against the
 * approval. Phase 6.5 Bug #1 fix means the picker tracks already-picked
 * (mode, source, source_id) keys for the arc; the same approval cannot
 * stack back-to-back. After the single phase closes, the picker filters
 * the only candidate, returns null, and the arc exits `nothing-queued`.
 *
 * Pre-Phase-6.5 this same setup ran six identical phases until the
 * budget cap tripped — see Phase 6 SUGGESTED-RANKER-FIXES Bug #1.
 */
import type { Scenario } from '../types.js';

const scenario: Scenario = {
  name: '01-revenue-single-approval',
  describe:
    'One pending approval -> revenue arc opens, runs ONE phase, then exits nothing-queued (per-arc dedupe).',
  initial_seed: {
    approvals: [
      { id: 'ap_demo', subject: 'fire DM approval', age_hours: 6, mode: 'revenue' },
    ],
  },
  steps: [{ kind: 'tick', note: 'first tick should pick the approval exactly once' }],
  assertions: [
    async (t) => {
      const tick = t.steps[0]?.tick_result;
      if (!tick?.ran) throw new Error('expected tick to run');
      if (tick.arc_status !== 'closed') {
        throw new Error(`expected arc closed, got ${tick.arc_status}`);
      }
      if (tick.exit_reason !== 'nothing-queued') {
        throw new Error(
          `expected exit_reason=nothing-queued (per-arc dedupe; Bug #1 fix), got ${tick.exit_reason}`,
        );
      }
    },
    async (t) => {
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      if (phases.length !== 1) {
        throw new Error(
          `expected exactly 1 phase per arc (per-arc dedupe), got ${phases.length}`,
        );
      }
      const only = phases[0];
      if (only.mode !== 'revenue') {
        throw new Error(`phase mode should be revenue, got ${only.mode}`);
      }
      if (!only.goal.includes('ap_demo')) {
        throw new Error(`phase goal should mention ap_demo, got ${only.goal}`);
      }
    },
  ],
};

export default scenario;
