/**
 * 12-within-arc-no-double-pick (Phase 6.5 Bug #1)
 *
 * Two distinct pending approvals at different ages. Without per-arc
 * dedupe, the older approval would re-pick to the budget cap and the
 * newer approval would never run. With dedupe, both approvals run as
 * separate phases inside one arc — older first (higher score), then
 * newer — and the arc exits `nothing-queued` with exactly two phases.
 */
import type { Scenario } from '../types.js';

const scenario: Scenario = {
  name: '12-within-arc-no-double-pick',
  describe:
    'Two distinct approvals -> both run as separate phases inside one arc; no same-source repeats; arc closes nothing-queued.',
  initial_seed: {
    approvals: [
      { id: 'ap_aaa', subject: 'older approval', age_hours: 24, mode: 'revenue' },
      { id: 'ap_bbb', subject: 'fresher approval', age_hours: 4, mode: 'revenue' },
    ],
  },
  steps: [
    {
      kind: 'tick',
      note: 'one arc runs both approvals (older first), then exits nothing-queued',
    },
  ],
  assertions: [
    async (t) => {
      const tick = t.steps[0]?.tick_result;
      if (!tick?.ran) throw new Error('expected tick to run');
      if (tick.arc_status !== 'closed') {
        throw new Error(`expected arc closed, got ${tick.arc_status}`);
      }
      if (tick.exit_reason !== 'nothing-queued') {
        throw new Error(
          `expected exit_reason=nothing-queued (both approvals consumed; per-arc dedupe), got ${tick.exit_reason}`,
        );
      }
    },
    async (t) => {
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      if (phases.length !== 2) {
        throw new Error(`expected exactly 2 phases, got ${phases.length}`);
      }
      // Older approval (higher score) ran first.
      if (!phases[0].goal.includes('ap_aaa')) {
        throw new Error(
          `expected first phase to target ap_aaa (older), got ${phases[0].goal}`,
        );
      }
      if (!phases[1].goal.includes('ap_bbb')) {
        throw new Error(
          `expected second phase to target ap_bbb (newer), got ${phases[1].goal}`,
        );
      }
      // No same-source repeats.
      const goals = phases.map((p) => p.goal);
      if (new Set(goals).size !== goals.length) {
        throw new Error(`expected unique goals; got ${goals.join(' | ')}`);
      }
    },
  ],
};

export default scenario;
