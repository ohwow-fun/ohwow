/**
 * 01-revenue-single-approval
 *
 * Baseline revenue path: a single 6h-old approval makes the Conductor
 * open a revenue-mode arc and run revenue phases against the approval
 * until the per-arc budget cap (6 phases) trips. Proves Tier-1 ranking
 * (approvals at score 100+age_h) AND the budget-cap exit path. The
 * cadence penalty (-50) is not enough to fully suppress an approval at
 * 106 score, so the same candidate keeps being picked — see
 * SUGGESTED-RANKER-FIXES in the Phase 6 report for the deeper
 * recommendation.
 */
import type { Scenario } from '../types.js';

const scenario: Scenario = {
  name: '01-revenue-single-approval',
  describe:
    'One pending approval -> revenue arc opens, runs phases until budget cap, exits budget.',
  initial_seed: {
    approvals: [
      { id: 'ap_demo', subject: 'fire DM approval', age_hours: 6, mode: 'revenue' },
    ],
  },
  steps: [{ kind: 'tick', note: 'first tick should pick the approval' }],
  assertions: [
    async (t) => {
      const tick = t.steps[0]?.tick_result;
      if (!tick?.ran) throw new Error('expected tick to run');
      if (tick.arc_status !== 'closed') {
        throw new Error(`expected arc closed, got ${tick.arc_status}`);
      }
      if (tick.exit_reason !== 'budget') {
        throw new Error(
          `expected exit_reason=budget (cadence penalty cannot fully suppress an approval), got ${tick.exit_reason}`,
        );
      }
    },
    async (t) => {
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      if (phases.length === 0) {
        throw new Error('expected at least one phase report');
      }
      const first = phases[phases.length - 1]; // started first (oldest)
      if (first.mode !== 'revenue') {
        throw new Error(`first phase mode should be revenue, got ${first.mode}`);
      }
      if (!first.goal.includes('ap_demo')) {
        throw new Error(`first phase goal should mention ap_demo, got ${first.goal}`);
      }
    },
  ],
};

export default scenario;
