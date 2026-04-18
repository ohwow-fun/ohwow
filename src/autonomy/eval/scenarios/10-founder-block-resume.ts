/**
 * 10-founder-block-resume
 *
 * The full inbox loop within a single arc. Setup:
 *   - One pending approval triggers a revenue arc.
 *   - The first plan round returns `needs-input` → orchestrator writes
 *     a `founder_inbox` row keyed to this phase + arc; trio exits
 *     `awaiting-founder`; phase comes back `phase-blocked-on-founder`.
 *   - A mid-arc hook simulates the founder answering the row
 *     (status='answered') between iterations — the live counterpart of
 *     a human invoking `ohwow_answer_founder_inbox`.
 *   - On the next iteration, the Director's `listAnsweredFounderInbox`
 *     surfaces the row in `newly_answered`. The ranker emits a
 *     `founder-answer` candidate at score topPulse + 200; picker picks
 *     it first; the new phase's plan brief carries the answer text.
 *
 * Proves: needs-input → founder_inbox row written; in-arc resume via
 * `newly_answered` lifts the answered row to top priority.
 *
 * Within-arc only: cross-arc resume (when the arc closes before the
 * answer lands) is a known gap — see SUGGESTED-RANKER-FIXES in the
 * Phase 6 report.
 */
import { defaultMakeStubExecutor } from '../../conductor.js';
import type { RoundBrief, RoundExecutor, RoundReturn } from '../../types.js';
import { setMidArcHook } from '../mid-arc-hook.js';
import type { Scenario } from '../types.js';

class NeedsInputOnceExecutor implements RoundExecutor {
  private fired = false;
  private readonly fallback = defaultMakeStubExecutor();
  async run(brief: RoundBrief): Promise<RoundReturn> {
    if (brief.kind === 'plan' && !this.fired) {
      this.fired = true;
      return {
        status: 'needs-input',
        summary: 'should we tighten scope?',
        next_round_brief: 'context: scope unclear',
        findings_written: [],
        commits: [],
      };
    }
    return this.fallback.run(brief);
  }
}

// makeExecutor returns a fresh instance each call so state (the `fired`
// flag) resets between the transcript run and the assertions re-run.
// The harness invokes makeExecutor once per scenario run, so this still
// preserves "fire once per run" semantics inside a single tick.

const scenario: Scenario = {
  name: '10-founder-block-resume',
  describe:
    'Plan needs-input -> founder_inbox row -> mid-arc hook answers it -> next iteration picks the founder-answer candidate.',
  initial_seed: {
    approvals: [
      { id: 'ap_block', subject: 'fire blocked DM', age_hours: 6, mode: 'revenue' },
    ],
  },
  steps: [
    {
      kind: 'tick',
      note: 'tick: needs-input writes inbox; mid-arc hook answers; resume picks founder-answer',
    },
  ],
  assertions: [
    async (t) => {
      // The arc should close (not abort) and at some point have written
      // an inbox row that ended in resolved (the Director resolves
      // answered rows on next iteration).
      const tick = t.steps[0]?.tick_result;
      if (!tick?.ran) throw new Error('expected tick to run');
      if (tick.arc_status !== 'closed') {
        throw new Error(
          `expected arc closed, got ${tick.arc_status} (${tick.exit_reason})`,
        );
      }
    },
    async (t, ctx) => {
      // At least one founder-answer-sourced phase must have run on this
      // arc, proving the resume path is active.
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      const founderAnswerPhase = phases.find((p) =>
        p.goal.includes('source=founder-answer'),
      );
      if (!founderAnswerPhase) {
        throw new Error(
          'expected at least one founder-answer-sourced phase; got: ' +
            phases.map((p) => p.goal).join(' | '),
        );
      }
      // And the inbox row must be in 'resolved' state by run end.
      const { data } = await ctx.db
        .from<{ id: string; status: string }>('founder_inbox')
        .select('id, status')
        .eq('workspace_id', ctx.workspace_id);
      const resolved = (data ?? []).filter((r) => r.status === 'resolved');
      if (resolved.length === 0) {
        throw new Error('expected at least one founder_inbox row to be resolved');
      }
    },
  ],
  makeExecutor: () => new NeedsInputOnceExecutor(),
};

// Mid-arc hook: after each phase closes, simulate the founder
// answering any still-open inbox rows. Idempotent: a no-op when no
// open rows remain. The harness invokes this hook on every iteration,
// so we don't clear it; subsequent calls find nothing to answer and
// short-circuit.
setMidArcHook(scenario.name, async (db, ctx) => {
  const { data } = await db
    .from<{ id: string; status: string; asked_at: string }>('founder_inbox')
    .select('id, status, asked_at')
    .eq('workspace_id', ctx.workspace_id)
    .eq('status', 'open')
    .order('asked_at', { ascending: false })
    .limit(1);
  const row = (data ?? [])[0];
  if (!row) return;
  await db
    .from('founder_inbox')
    .update({
      status: 'answered',
      answer: 'tighten scope to one caller',
      answered_at: ctx.now().toISOString(),
    })
    .eq('id', row.id);
});

export default scenario;
