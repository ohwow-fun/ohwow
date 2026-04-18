/**
 * 02-revenue-two-approvals-age-tiebreak
 *
 * Two pending approvals, one fresh (4h) and one old (24h). Approval
 * scoring is `100 + age_hours`, so the older one has score 124 vs 104,
 * and the older approval should be picked first. Proves age scoring
 * within a single mode candidate set.
 */
import type { Scenario } from '../types.js';

const scenario: Scenario = {
  name: '02-revenue-two-approvals-age-tiebreak',
  describe:
    'Two approvals: ranker picks the older one first by age score (100 + age_hours).',
  initial_seed: {
    approvals: [
      { id: 'ap_fresh', subject: 'fresh approval', age_hours: 4, mode: 'revenue' },
      { id: 'ap_old', subject: 'old approval', age_hours: 24, mode: 'revenue' },
    ],
  },
  steps: [{ kind: 'tick', note: 'tick should pick the older approval first' }],
  assertions: [
    async (t) => {
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      if (phases.length === 0) throw new Error('no phases ran');
      const first = phases[0];
      if (!first.goal.includes('ap_old')) {
        throw new Error(
          `expected first phase goal to mention ap_old, got ${first.goal}`,
        );
      }
    },
    async (t) => {
      // Both approvals appear over the arc's lifetime; the scenario's
      // value is the FIRST pick being the older one.
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      const goalsTouched = new Set(phases.map((p) => p.goal));
      if (![...goalsTouched].some((g) => g.includes('ap_old'))) {
        throw new Error('expected ap_old to be touched');
      }
    },
  ],
};

export default scenario;
