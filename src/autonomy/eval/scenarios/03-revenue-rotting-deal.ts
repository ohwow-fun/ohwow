/**
 * 03-revenue-rotting-deal
 *
 * No approvals; one deal idle for 14 days. Rotting deals score
 * `80 + idle_days * 2 = 108` and should fall under revenue. Proves the
 * second-tier revenue path keys off the deal once approvals are absent.
 */
import type { Scenario } from '../types.js';

const scenario: Scenario = {
  name: '03-revenue-rotting-deal',
  describe:
    'No approvals + one rotting deal -> revenue arc keyed off deal id.',
  initial_seed: {
    deals: [
      { id: 'deal_alpha', idle_days: 14, stage: 'Qualified', expected_value_cents: 50000 },
    ],
  },
  steps: [{ kind: 'tick' }],
  assertions: [
    async (t) => {
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      if (phases.length === 0) throw new Error('no phases ran');
      const first = phases[0];
      if (first.mode !== 'revenue') {
        throw new Error(`expected revenue mode, got ${first.mode}`);
      }
      if (!first.goal.includes('deal_alpha')) {
        throw new Error(`expected goal to mention deal_alpha, got ${first.goal}`);
      }
    },
    async (t) => {
      const tick = t.steps[0]?.tick_result;
      if (tick?.arc_status !== 'closed') {
        throw new Error(`arc should close cleanly, got ${tick?.arc_status}`);
      }
    },
  ],
};

export default scenario;
