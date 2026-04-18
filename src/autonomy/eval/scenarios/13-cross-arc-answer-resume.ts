/**
 * 13-cross-arc-answer-resume (Phase 6.5 Bug #2)
 *
 * Setup:
 *   - A prior arc (`arc_prior`) closed with `founder-returned` and left
 *     one `answered`-status inbox row behind (the founder answered
 *     after the arc closed).
 *   - The pulse offers a low-priority failing trigger (score 40+0=40).
 *
 * Pre-fix: the new conductor tick opens a new arc, the Director's per-
 * arc `listAnsweredFounderInbox(new_arc_id)` finds nothing, and the
 * picker only sees the failing trigger. The cross-arc answer is
 * stranded.
 *
 * Post-fix: the conductor pre-fetches workspace-wide answered-and-
 * unresolved inbox rows BEFORE entering `runArc`. The picker's first
 * call gets the answered row in `newly_answered`, the ranker emits a
 * `founder-answer` candidate at score 200+, and the new arc runs the
 * founder-answer phase first. The picker then resolves the seeded row
 * so subsequent picker calls don't see it.
 */
import type { Scenario } from '../types.js';

const scenario: Scenario = {
  name: '13-cross-arc-answer-resume',
  describe:
    'Closed prior arc with one answered (unresolved) inbox row + a low-priority pulse trigger -> new arc picks the founder-answer first.',
  initial_seed: {
    failing_triggers: [
      {
        id: 'trig_low',
        class: 'cron-low',
        failure_count: 0,
        last_failure_hours_ago: 1,
      },
    ],
    founder_inbox: [
      {
        id: 'fi_cross',
        arc_id: 'arc_prior',
        // No phase_id — it would need a real prior phase report row;
        // the cross-arc resume path doesn't need it.
        mode: 'plumbing',
        blocker: 'should we tighten scope?',
        status: 'answered',
        answer: 'tighten to one caller',
        asked_hours_ago: 2,
      },
    ],
  },
  steps: [
    { kind: 'tick', note: 'new arc opens; founder-answer outranks the trigger; row resolved' },
  ],
  assertions: [
    async (t) => {
      const tick = t.steps[0]?.tick_result;
      if (!tick?.ran) throw new Error('expected tick to run');
      if (tick.arc_status !== 'closed') {
        throw new Error(`expected arc closed, got ${tick.arc_status}`);
      }
    },
    async (t) => {
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      if (phases.length === 0) throw new Error('expected at least one phase');
      const first = phases[0];
      if (!first.goal.includes('source=founder-answer')) {
        throw new Error(
          `expected first phase to be founder-answer, got ${first.goal}`,
        );
      }
      if (!first.goal.includes('fi_cross')) {
        throw new Error(`expected first phase to mention fi_cross, got ${first.goal}`);
      }
    },
    async (t, ctx) => {
      // The seeded answered row should be `resolved` after the tick
      // (the picker's seed-drain resolves it so subsequent calls and
      // future ticks don't re-process it).
      const { data } = await ctx.db
        .from<{ id: string; status: string }>('founder_inbox')
        .select('id, status')
        .eq('id', 'fi_cross');
      const row = (data ?? [])[0];
      if (!row) throw new Error('expected fi_cross to exist');
      if (row.status !== 'resolved') {
        throw new Error(`expected fi_cross resolved, got ${row.status}`);
      }
    },
  ],
};

export default scenario;
