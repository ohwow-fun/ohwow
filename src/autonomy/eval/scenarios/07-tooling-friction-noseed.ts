/**
 * 07-tooling-friction-noseed
 *
 * Negative test for the tooling lens. With NO `tooling-friction`
 * findings seeded, the tooling candidate set is empty and the ranker
 * never emits a tooling-mode pick. Proves the tooling lens does not
 * misfire on an empty signal.
 */
import type { Scenario } from '../types.js';

const scenario: Scenario = {
  name: '07-tooling-friction-noseed',
  describe:
    'Empty pulse + no tooling-friction findings -> tooling never picked, arc no-ops.',
  initial_seed: {},
  steps: [{ kind: 'tick' }],
  assertions: [
    async (t) => {
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      const toolingPhases = phases.filter((p) => p.mode === 'tooling');
      if (toolingPhases.length !== 0) {
        throw new Error(
          `expected zero tooling phases, got ${toolingPhases.length}`,
        );
      }
    },
    async (t) => {
      const tick = t.steps[0]?.tick_result;
      if (tick?.exit_reason !== 'nothing-queued') {
        throw new Error(
          `expected exit_reason=nothing-queued, got ${tick?.exit_reason}`,
        );
      }
    },
  ],
};

export default scenario;
