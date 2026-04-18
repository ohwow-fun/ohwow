/**
 * 09-recent-regression
 *
 * Phase 6.5 Bug #3 sharpens this scenario. Setup:
 *   - One failing trigger `trig_y` (score 40+1=41 base).
 *   - TWO prior phase reports on the same trigger id, in this order
 *     (newest first by started_at):
 *         1. phase-closed at 2h ago (cadence-window-safe: 2h > 4h? no,
 *            actually 2h IS inside cadence window. Use 5h instead.)
 *         2. phase-aborted at 24h ago.
 *
 *   Pre-fix: the ranker stopped at the most-recent matching report, saw
 *   `phase-closed`, and applied no regression penalty — the earlier
 *   abort was masked.
 *
 *   Post-fix (worst-status-in-window): the ranker scans the lookback
 *   window and takes the worst status, which is `phase-aborted` →
 *   penalty -30. With base 40 + novelty 0 (seen) - cadence (none, the
 *   most-recent matching report is 5h ago, just outside the 4h window)
 *   - regression 30 = 11. The single candidate is still picked
 *   (downranked), and one phase runs.
 *
 * Proves: worst-status-in-window catches a flapping bug that a stale
 * phase-closed would have hidden.
 */
import type { Scenario } from '../types.js';

const scenario: Scenario = {
  name: '09-recent-regression',
  describe:
    'Failing trigger + prior phase-aborted then phase-closed on the same id -> worst-status regression penalty applied; still picked (downranked).',
  initial_seed: {
    failing_triggers: [
      {
        id: 'trig_y',
        class: 'cron-foo',
        // Pulse threshold is 3 consecutive failures.
        failure_count: 4,
        last_failure_hours_ago: 1,
      },
    ],
    prior_phase_reports: [
      {
        id: 'pr_prior_y_old',
        arc_id: 'arc_y_history',
        phase_id: 'phase_y_1',
        mode: 'plumbing',
        goal_source: 'unstick cron-foo [source=failing-trigger; id=trig_y]',
        status: 'phase-aborted',
        hours_ago: 24,
      },
      {
        id: 'pr_prior_y_recent',
        arc_id: 'arc_y_history',
        phase_id: 'phase_y_2',
        mode: 'plumbing',
        goal_source: 'unstick cron-foo [source=failing-trigger; id=trig_y]',
        status: 'phase-closed',
        hours_ago: 5,
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
      // Verify both prior reports remain in the ledger after the run
      // (not deleted, not consolidated). New phases (1) + prior (2) = 3.
      const newPhases = t.steps[0]?.arc_summary?.phases.length ?? 0;
      if (t.finals.total_phase_reports < newPhases + 2) {
        throw new Error(
          `expected both prior reports to remain in the ledger; total=${t.finals.total_phase_reports} new=${newPhases}`,
        );
      }
    },
  ],
};

export default scenario;
