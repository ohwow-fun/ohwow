/**
 * 06-plumbing-failing-trigger
 *
 * Only signal is a failing trigger (5 consecutive failures). Plumbing
 * scores 40 + failure_count = 45. Proves the plumbing lens picks up
 * trigger watchdog state and routes the work into a plumbing arc.
 */
import type { Scenario } from '../types.js';

const scenario: Scenario = {
  name: '06-plumbing-failing-trigger',
  describe: 'One failing trigger -> plumbing arc keyed off trigger id.',
  initial_seed: {
    failing_triggers: [
      {
        id: 'trig_x',
        class: 'cron-x-intel',
        failure_count: 5,
        last_failure_hours_ago: 1,
      },
    ],
  },
  steps: [{ kind: 'tick' }],
  assertions: [
    async (t) => {
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      if (phases.length === 0) throw new Error('expected plumbing phase to run');
      if (phases[0].mode !== 'plumbing') {
        throw new Error(`expected plumbing mode, got ${phases[0].mode}`);
      }
      if (!phases[0].goal.includes('cron-x-intel')) {
        throw new Error(
          `expected goal to mention trigger class, got ${phases[0].goal}`,
        );
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
