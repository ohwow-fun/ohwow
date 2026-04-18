/**
 * 14-restart-mid-arc-no-double-pick (Phase 6.7 Deliverable A)
 *
 * Proves: a fresh picker built against an existing OPEN arc rebuilds its
 * dedupe set from the persisted phase_ids and refuses to re-pick the
 * same source.
 *
 * Pre-Phase-6.7: per-arc `picked_keys` was held only in the picker
 * closure's in-memory set. If the daemon crashed mid-arc and restarted,
 * the resumed `runArc` would build a fresh picker with an empty set and
 * could re-pick a source the prior process already ran. Phase 6.7
 * encodes the source provenance into `phase_id` and ships
 * `reconstructPickedKeys(arc_id)` to rebuild the set on first picker
 * call.
 *
 * Setup:
 *   - One OPEN director_arc (synthetic, via prior_phase_reports
 *     seeding with `parent_arc_open: true`).
 *   - One persisted phase_report inside that arc with the v1-format
 *     phase_id encoding mode=revenue source=approval id=ap_target.
 *   - The `ap_target` approval is still pending.
 *
 * Step:
 *   - `restart-pick-once` against the open arc id. The harness builds a
 *     fresh picker, runs `reconstructPickedKeys(arc_id)`, and invokes
 *     the picker once.
 *
 * Assertion: the picker did NOT re-pick `ap_target` (returned `none`,
 * since that's the only candidate). The transcript captures the picker
 * decision.
 */
import { PHASE_ID_FORMAT_VERSION } from '../../conductor.js';
import type { Scenario } from '../types.js';

const RESTART_ARC_ID = 'arc_restart';

// Build a v1-format phase_id by hand so the reconstruct parser matches.
// The ranker emits goals like `fire approval ap_target [source=approval; id=ap_target]`,
// but reconstruction reads `phase_id` directly — that's the field we
// must encode correctly. Format: p<ver>_<stamp>_<mode>_<source>_<source_id>_<seq>.
const PRIOR_PHASE_ID = `p${PHASE_ID_FORMAT_VERSION}_20260418000000_revenue_approval_ap_target_1`;

const scenario: Scenario = {
  name: '14-restart-mid-arc-no-double-pick',
  describe:
    'Open arc + persisted phase report (v1 phase_id) for ap_target; same approval still pending. A fresh picker resumes, reconstructPickedKeys dedupes, picker returns none.',
  initial_seed: {
    approvals: [
      { id: 'ap_target', subject: 'already picked in this arc', age_hours: 6, mode: 'revenue' },
    ],
    prior_phase_reports: [
      {
        id: 'pr_target_1',
        arc_id: RESTART_ARC_ID,
        phase_id: PRIOR_PHASE_ID,
        mode: 'revenue',
        goal_source:
          'fire approval ap_target [source=approval; id=ap_target]',
        status: 'phase-closed',
        hours_ago: 1,
        parent_arc_open: true,
      },
    ],
  },
  steps: [
    {
      kind: 'restart-pick-once',
      restart_arc_id: RESTART_ARC_ID,
      note:
        'fresh picker resumes against the open arc; reconstructPickedKeys parses the v1 phase_id and dedupes',
    },
  ],
  assertions: [
    async (t) => {
      const step0 = t.steps[0];
      if (step0?.kind !== 'restart-pick-once') {
        throw new Error('expected step 0 to be restart-pick-once');
      }
      const pick = step0.restart_pick;
      if (!pick) throw new Error('expected restart_pick to be recorded');
      if (pick.picked) {
        throw new Error(
          `expected picker to return none (ap_target already picked), got mode=${pick.mode} goal=${pick.goal}`,
        );
      }
    },
  ],
};

export default scenario;
