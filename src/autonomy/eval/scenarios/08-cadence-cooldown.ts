/**
 * 08-cadence-cooldown
 *
 * Two `tooling-friction` findings of the same subject (count >= 2 makes
 * it a tooling candidate at score 20) PLUS a prior phase report on the
 * same (mode, source, id) tuple started 1h ago. The cadence penalty
 * (-50, applies when last touched <= 4h) drops the score from 20 to
 * -30, the ranker filters anything <= 0, and the conductor has nothing
 * to pick.
 *
 * Proves the cadence penalty correctly suppresses repeat work that fell
 * below the score floor. Higher-score candidates (approvals, deals,
 * triggers) survive cadence because the penalty is not enough to drag
 * them under zero — see SUGGESTED-RANKER-FIXES.
 */
import type { Scenario } from '../types.js';

const scenario: Scenario = {
  name: '08-cadence-cooldown',
  describe:
    'Tooling friction + recent matching phase report -> cadence drops it below zero, nothing queued.',
  initial_seed: {
    findings: [
      { id: 'find_a', category: 'tooling-friction', verdict: 'pass', subject: 'forge_x', hours_ago: 12 },
      { id: 'find_b', category: 'tooling-friction', verdict: 'pass', subject: 'forge_x', hours_ago: 6 },
    ],
    prior_phase_reports: [
      {
        id: 'pr_prior',
        arc_id: 'arc_history',
        phase_id: 'phase_history_1',
        mode: 'tooling',
        goal_source: 'forge forge_x [source=tooling-friction; id=forge_x]',
        status: 'phase-closed',
        hours_ago: 1,
      },
    ],
  },
  steps: [
    {
      kind: 'tick',
      note: 'cadence should suppress the tooling candidate to nothing-queued',
    },
  ],
  assertions: [
    async (t) => {
      const tick = t.steps[0]?.tick_result;
      if (tick?.exit_reason !== 'nothing-queued') {
        throw new Error(
          `cadence should suppress; expected nothing-queued, got ${tick?.exit_reason}`,
        );
      }
    },
    async (t) => {
      // No NEW phase reports should land for the test arc.
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      if (phases.length !== 0) {
        throw new Error(
          `expected zero new phases under cadence; got ${phases.length}`,
        );
      }
    },
  ],
};

export default scenario;
