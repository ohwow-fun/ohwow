/**
 * 04-revenue-qualified-no-outreach
 *
 * One contact qualified 48h ago, no outbound DM. Qualified-no-outreach
 * scores 60 (revenue tier 3). Proves the third-tier revenue path
 * surfaces when nothing higher-priority is queued.
 */
import type { Scenario } from '../types.js';

const scenario: Scenario = {
  name: '04-revenue-qualified-no-outreach',
  describe:
    'Only signal is a qualified contact with no outreach -> revenue phase.',
  initial_seed: {
    contacts_qualified: [
      { id: 'contact_alice', name: 'Alice', qualified_hours_ago: 48 },
    ],
  },
  steps: [{ kind: 'tick' }],
  assertions: [
    async (t) => {
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      if (phases.length === 0) {
        throw new Error('expected at least one phase report');
      }
      const first = phases[0];
      if (first.mode !== 'revenue') {
        throw new Error(`expected revenue mode, got ${first.mode}`);
      }
      if (!first.goal.includes('contact_alice')) {
        throw new Error(`expected goal to mention contact_alice, got ${first.goal}`);
      }
    },
    async (t) => {
      // Source should be qualified-no-outreach (encoded into goal).
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      const sourceMatches = phases[0]?.goal.includes('source=qualified-no-outreach');
      if (!sourceMatches) {
        throw new Error('expected source=qualified-no-outreach in goal provenance');
      }
    },
  ],
};

export default scenario;
