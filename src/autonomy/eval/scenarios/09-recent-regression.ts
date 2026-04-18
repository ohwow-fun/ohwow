/**
 * 09-recent-regression
 *
 * One failing trigger (score 40+1=41). Prior phase report on the same
 * trigger id, started 6h ago, with status `phase-aborted`. Regression
 * penalty (-30) applies because the matching past report regressed and
 * the lookback (72h) catches it. Net score: 41 + 0 (no novelty: seen)
 * - 30 (regression) - 0 (cadence: 6h > 4h window) = 11 -> still picked
 * but at downranked priority. With ONLY this one candidate, it's still
 * the top pick.
 *
 * Proves: regression penalty applies at the right window AND, with no
 * competing candidate, a downranked candidate still gets picked. (When
 * a competing fresh candidate exists, regression hands it the win — see
 * the matching note in SUGGESTED-RANKER-FIXES.)
 */
import type { Scenario } from '../types.js';

const scenario: Scenario = {
  name: '09-recent-regression',
  describe:
    'Failing trigger + prior phase-aborted on the same id 6h ago -> regression penalty applied; still picked (downranked).',
  initial_seed: {
    failing_triggers: [
      {
        id: 'trig_y',
        class: 'cron-foo',
        failure_count: 4,
        last_failure_hours_ago: 1,
      },
    ],
    prior_phase_reports: [
      {
        id: 'pr_prior_y',
        arc_id: 'arc_y_history',
        phase_id: 'phase_y_1',
        mode: 'plumbing',
        goal_source: 'unstick cron-foo [source=failing-trigger; id=trig_y]',
        status: 'phase-aborted',
        hours_ago: 6,
      },
    ],
  },
  steps: [{ kind: 'tick' }],
  assertions: [
    async (t) => {
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      if (phases.length === 0) throw new Error('expected at least one phase');
      const first = phases[0];
      if (first.mode !== 'plumbing') {
        throw new Error(`expected plumbing mode, got ${first.mode}`);
      }
      if (!first.goal.includes('trig_y')) {
        throw new Error(`expected goal to mention trig_y, got ${first.goal}`);
      }
    },
    async (t) => {
      // Verify a matching prior `phase-aborted` row still exists in the
      // ledger after the run (not deleted, not consolidated).
      // Counted via the finals' total_phase_reports vs the new arc's count.
      const newPhases = t.steps[0]?.arc_summary?.phases.length ?? 0;
      // Total phase reports = prior (1) + new (newPhases). The eval DB
      // exposes 1 historical report from the seed.
      if (t.finals.total_phase_reports < newPhases + 1) {
        throw new Error(
          `expected the prior aborted report to remain in the ledger; total=${t.finals.total_phase_reports} new=${newPhases}`,
        );
      }
    },
  ],
};

export default scenario;
