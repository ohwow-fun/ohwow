/**
 * 05-polish-dashboard-red
 *
 * No revenue signals; one dashboard-smoke fail finding inside the 24h
 * lookback. The polish lens scores 50; nothing else competes. Proves
 * the polish-mode lens picks up a recent dashboard failure.
 */
import type { Scenario } from '../types.js';

const scenario: Scenario = {
  name: '05-polish-dashboard-red',
  describe:
    'Dashboard smoke fail in last 24h -> polish-mode arc keyed off the failure surface.',
  initial_seed: {
    findings: [
      {
        id: 'find_dash',
        category: 'dashboard-smoke',
        verdict: 'fail',
        subject: '/dashboard/agents',
        hours_ago: 2,
      },
    ],
  },
  steps: [{ kind: 'tick' }],
  assertions: [
    async (t) => {
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      if (phases.length === 0) throw new Error('expected polish phase to run');
      const first = phases[0];
      if (first.mode !== 'polish') {
        throw new Error(`expected polish mode, got ${first.mode}`);
      }
      if (!first.goal.includes('/dashboard/agents')) {
        throw new Error(`expected goal to mention surface, got ${first.goal}`);
      }
    },
    async (t) => {
      const sourceMatch = t.steps[0]?.arc_summary?.phases[0]?.goal.includes(
        'source=dashboard-red',
      );
      if (!sourceMatch) {
        throw new Error('expected source=dashboard-red provenance');
      }
    },
  ],
};

export default scenario;
