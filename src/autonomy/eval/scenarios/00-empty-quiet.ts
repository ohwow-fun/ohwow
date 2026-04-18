/**
 * 00-empty-quiet
 *
 * Proves the no-op path: an empty pulse + empty ledger should still
 * open an arc on a tick, the picker returns null on first iteration,
 * and the arc closes immediately with `nothing-queued`. This is the
 * baseline "Conductor correctly does nothing" case the conductor must
 * survive in production whenever the operator's business is quiet.
 */
import type { Scenario } from '../types.js';

const scenario: Scenario = {
  name: '00-empty-quiet',
  describe:
    'Empty pulse: tick opens an arc that closes with nothing-queued and no phase reports.',
  initial_seed: {},
  steps: [{ kind: 'tick', note: 'baseline empty tick' }],
  assertions: [
    async (t) => {
      const tick = t.steps[0]?.tick_result;
      if (!tick?.ran) throw new Error('expected tick to run');
      if (tick.exit_reason !== 'nothing-queued') {
        throw new Error(
          `expected exit_reason=nothing-queued, got ${tick.exit_reason}`,
        );
      }
      if (t.finals.total_phase_reports !== 0) {
        throw new Error(
          `expected zero phase reports, got ${t.finals.total_phase_reports}`,
        );
      }
    },
    async (t) => {
      if (t.finals.open_arcs !== 0) {
        throw new Error('arc should be closed');
      }
      if (t.finals.closed_arcs !== 1) {
        throw new Error(
          `expected exactly 1 closed arc, got ${t.finals.closed_arcs}`,
        );
      }
    },
  ],
};

export default scenario;
