/**
 * 10-founder-block-resume
 *
 * The full cross-arc inbox loop. Phase 6.5 Bug #2 fix means an answered
 * inbox row whose originating arc has CLOSED is still picked up by the
 * next conductor tick (workspace-wide pre-fetch, not per-arc poll).
 * Setup:
 *   - One pending approval triggers a revenue arc.
 *   - The first plan round returns `needs-input` → orchestrator writes
 *     a `founder_inbox` row keyed to this phase + arc; trio exits
 *     `awaiting-founder`; phase comes back `phase-blocked-on-founder`.
 *   - With per-arc dedupe (Bug #1), the picker drops the same approval
 *     for the rest of this arc and the arc closes `nothing-queued`
 *     leaving an open inbox row behind.
 *   - An `answer-founder` step resolves the inbox row to `answered`.
 *   - A second tick opens a NEW arc. The conductor's workspace-wide
 *     answered pre-fetch surfaces the row, the picker emits the
 *     founder-answer candidate at score 200+, and the new arc runs the
 *     founder-answer phase.
 *
 * Proves: needs-input → founder_inbox row written; cross-arc resume via
 * workspace-wide answered pre-fetch lifts the answered row to top
 * priority on the next tick.
 */
import { defaultMakeStubExecutor } from '../../conductor.js';
import type { RoundBrief, RoundExecutor, RoundReturn } from '../../types.js';
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

const scenario: Scenario = {
  name: '10-founder-block-resume',
  describe:
    'Tick 1: plan needs-input -> founder_inbox row -> arc closes with row open. answer-founder. Tick 2: new arc picks up the answered row via workspace-wide pre-fetch.',
  initial_seed: {
    approvals: [
      { id: 'ap_block', subject: 'fire blocked DM', age_hours: 6, mode: 'revenue' },
    ],
  },
  steps: [
    {
      kind: 'tick',
      note: 'tick 1: needs-input writes inbox; per-arc dedupe means arc exits with the inbox row open',
    },
    {
      kind: 'answer-founder',
      founder_inbox_id: 'fi_001',
      founder_answer: 'tighten scope to one caller',
      note: 'founder answers between ticks',
    },
    {
      kind: 'tick',
      note: 'tick 2: new arc opens; workspace-wide pre-fetch surfaces fi_001; founder-answer runs first',
    },
  ],
  assertions: [
    async (t) => {
      const tick1 = t.steps[0]?.tick_result;
      if (!tick1?.ran) throw new Error('expected tick 1 to run');
      if (tick1.arc_status !== 'closed') {
        throw new Error(
          `expected tick 1 arc closed, got ${tick1.arc_status} (${tick1.exit_reason})`,
        );
      }
      // Tick 1's only candidate was the approval; first plan returned
      // needs-input, leaving the approval as a "picked once" key. The
      // picker then has nothing else to pick and exits nothing-queued.
      if (tick1.exit_reason !== 'nothing-queued') {
        throw new Error(
          `expected tick 1 exit_reason=nothing-queued (per-arc dedupe), got ${tick1.exit_reason}`,
        );
      }
      const phases1 = t.steps[0]?.arc_summary?.phases ?? [];
      if (phases1.length !== 1) {
        throw new Error(
          `expected exactly 1 phase in tick 1's arc, got ${phases1.length}`,
        );
      }
      if (phases1[0].status !== 'phase-blocked-on-founder') {
        throw new Error(
          `expected phase-blocked-on-founder, got ${phases1[0].status}`,
        );
      }
    },
    async (t) => {
      const tick2 = t.steps[2]?.tick_result;
      if (!tick2?.ran) throw new Error('expected tick 2 to run');
      if (tick2.arc_status !== 'closed') {
        throw new Error(
          `expected tick 2 arc closed, got ${tick2.arc_status} (${tick2.exit_reason})`,
        );
      }
      const phases2 = t.steps[2]?.arc_summary?.phases ?? [];
      const founderAnswerPhase = phases2.find((p) =>
        p.goal.includes('source=founder-answer'),
      );
      if (!founderAnswerPhase) {
        throw new Error(
          'expected at least one founder-answer-sourced phase in tick 2; got: ' +
            phases2.map((p) => p.goal).join(' | '),
        );
      }
    },
    async (t, ctx) => {
      // The inbox row must be in 'resolved' state by run end (the
      // picker resolves seeded rows after merging them).
      const { data } = await ctx.db
        .from<{ id: string; status: string }>('founder_inbox')
        .select('id, status')
        .eq('workspace_id', ctx.workspace_id)
        .eq('id', 'fi_001');
      const row = (data ?? [])[0];
      if (!row) throw new Error('expected fi_001 inbox row to exist');
      if (row.status !== 'resolved') {
        throw new Error(
          `expected fi_001 to be resolved by tick 2, got ${row.status}`,
        );
      }
    },
  ],
  makeExecutor: () => new NeedsInputOnceExecutor(),
};

export default scenario;
