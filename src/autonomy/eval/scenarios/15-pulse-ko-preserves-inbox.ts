/**
 * 15-pulse-ko-preserves-inbox (Phase 6.7 Deliverable B)
 *
 * Proves: the conductor's seed pre-fetch + the Director's deferred-resolve
 * contract together preserve a freshly-answered inbox row when an arc
 * aborts via pulse-ko BEFORE the founder-answer phase reaches `in-flight`.
 *
 * Pre-Phase-6.7 the conductor's picker resolved seeded answered rows
 * the moment it merged them into `mergedAnswered`. If pulse-ko then
 * tripped before the phase actually started, the inbox row was already
 * `resolved` and the next tick's pre-fetch wouldn't re-surface it — the
 * answer was lost.
 *
 * Phase 6.7 moves the resolve into the Director, AFTER the phase report
 * row transitions to `status='in-flight'`. Any pre-pick abort path
 * (pulse-ko, budget, inbox-cap) now leaves the row intact.
 *
 * Setup:
 *   - One pending approval drives the first phase.
 *   - Entry MRR is 10000 (stored in business_vitals).
 *   - A mid-arc hook fires AFTER the first phase completes:
 *       (a) inserts an answered+unresolved founder_inbox row (so the
 *           NEXT tick's pre-fetch will see it);
 *       (b) drops MRR to 8000 in business_vitals.
 *   - On iteration 2, the Director's pulse-regression check detects the
 *     MRR drop and aborts the arc BEFORE the picker is called.
 *
 * Assertions:
 *   - Tick 1 arc status='aborted', exit_reason='pulse-ko'.
 *   - The mid-arc-injected inbox row is `answered` (NOT `resolved`)
 *     after the tick — proving the resolve never fired because the
 *     picker never picked it.
 *   - A second tick re-surfaces the row via pre-fetch and resolves it
 *     after a clean founder-answer phase.
 */
import { defaultMakeStubExecutor } from '../../conductor.js';
import type { RoundBrief, RoundExecutor, RoundReturn } from '../../types.js';
import { setMidArcHook } from '../mid-arc-hook.js';
import type { Scenario } from '../types.js';

class PassthroughExecutor implements RoundExecutor {
  private readonly fallback = defaultMakeStubExecutor();
  async run(brief: RoundBrief): Promise<RoundReturn> {
    return this.fallback.run(brief);
  }
}

const sharedExecutor = new PassthroughExecutor();

const scenario: Scenario = {
  name: '15-pulse-ko-preserves-inbox',
  describe:
    'Mid-arc hook injects an answered inbox row + drops MRR; iteration 2 pulse-ko aborts before the picker fires; the inbox row stays answered for the next tick.',
  initial_seed: {
    approvals: [
      { id: 'ap_first', subject: 'fire approval (drives phase 1)', age_hours: 6, mode: 'revenue' },
    ],
    business_vitals: { mrr_cents: 10000 },
  },
  steps: [
    {
      kind: 'tick',
      note:
        'tick 1: phase 1 runs the approval; mid-arc hook injects answered inbox + drops MRR; iter 2 pulse-ko aborts before any pick',
    },
    {
      kind: 'tick',
      note:
        'tick 2: pre-fetch surfaces the still-answered inbox row; founder-answer phase runs and resolves it',
    },
  ],
  assertions: [
    async (t) => {
      const tick1 = t.steps[0]?.tick_result;
      if (!tick1?.ran) throw new Error('expected tick 1 to run');
      if (tick1.arc_status !== 'aborted') {
        throw new Error(
          `expected tick 1 arc aborted, got ${tick1.arc_status}`,
        );
      }
      if (tick1.exit_reason !== 'pulse-ko') {
        throw new Error(
          `expected tick 1 exit_reason=pulse-ko, got ${tick1.exit_reason}`,
        );
      }
    },
    async (t) => {
      // Tick 1's inbox_changes diff captures the row's status AT THE
      // END of tick 1 (before tick 2 fires). The post-tick-1 status
      // must be 'answered' — proving the picker never picked it,
      // because pulse-ko tripped on iteration 2 before any picker
      // call. We read this off the transcript (not the live DB) since
      // the assertion reruns all steps and the live DB shows the
      // post-tick-2 state.
      const tick1Changes = t.steps[0]?.inbox_changes ?? [];
      const fiPkoChange = tick1Changes.find((c) => c.id === 'fi_pko');
      if (!fiPkoChange) {
        throw new Error(
          'expected fi_pko inbox change recorded for tick 1 (mid-arc hook should have inserted it)',
        );
      }
      if (fiPkoChange.status !== 'answered') {
        throw new Error(
          `expected fi_pko->answered after tick 1, got fi_pko->${fiPkoChange.status} — deferred-resolve regressed (the picker resolved it pre-in-flight)`,
        );
      }
    },
    async (t) => {
      // Tick 2: a fresh arc opens, the pre-fetch picks up the still-
      // answered inbox row, the picker emits founder-answer, and the
      // Director's post-in-flight resolve flips it to resolved.
      const tick2 = t.steps[1]?.tick_result;
      if (!tick2?.ran) throw new Error('expected tick 2 to run');
      const phases2 = t.steps[1]?.arc_summary?.phases ?? [];
      const founderAnswerPhase = phases2.find((p) =>
        p.goal.includes('source=founder-answer'),
      );
      if (!founderAnswerPhase) {
        throw new Error(
          'expected at least one founder-answer phase in tick 2; got: ' +
            phases2.map((p) => p.goal).join(' | '),
        );
      }
    },
    async (t, ctx) => {
      // After tick 2 the row should finally be resolved — the post-in-
      // flight resolve fired when the founder-answer phase landed. The
      // assertion harness re-runs all steps so the live DB IS the
      // post-tick-2 state by the time we read here.
      const { data } = await ctx.db
        .from<{ id: string; status: string }>('founder_inbox')
        .select('id, status')
        .eq('id', 'fi_pko');
      const row = (data ?? [])[0];
      if (!row) throw new Error('expected fi_pko to exist after tick 2');
      if (row.status !== 'resolved') {
        throw new Error(
          `expected fi_pko resolved after tick 2, got '${row.status}'`,
        );
      }
      // Tick 2's inbox_changes captures the resolve transition.
      const tick2Changes = t.steps[1]?.inbox_changes ?? [];
      const change = tick2Changes.find((c) => c.id === 'fi_pko');
      if (!change || change.status !== 'resolved') {
        throw new Error(
          `expected fi_pko->resolved in tick 2's inbox_changes, got ${change?.status ?? 'no change'}`,
        );
      }
    },
  ],
  makeExecutor: () => sharedExecutor,
};

setMidArcHook(scenario.name, async (db, ctx) => {
  // Fire only once: insert the inbox row + drop MRR. The hook fires
  // after EVERY phase completes; we guard so the second invocation
  // (after the founder-answer phase in tick 2) is a no-op.
  const existing = await db
    .from<{ id: string }>('founder_inbox')
    .select('id')
    .eq('id', 'fi_pko');
  if ((existing.data ?? []).length > 0) return;

  await db.from('founder_inbox').insert({
    id: 'fi_pko',
    workspace_id: ctx.workspace_id,
    arc_id: null,
    phase_id: null,
    mode: 'plumbing',
    blocker: 'should we tighten plumbing scope?',
    context: 'mid-arc injected blocker',
    options_json: '[]',
    recommended: null,
    screenshot_path: null,
    asked_at: ctx.now().toISOString(),
    answered_at: ctx.now().toISOString(),
    answer: 'tighten to one caller',
    status: 'answered',
  });

  // Drop MRR — same shape as scenario 11.
  const futureTs = new Date(ctx.now().getTime() + 1).toISOString();
  await db.from('business_vitals').insert({
    id: 'vital_pko_drop',
    workspace_id: ctx.workspace_id,
    ts: futureTs,
    mrr: 8000,
    arr: 96000,
    active_users: null,
    daily_cost_cents: null,
    runway_days: null,
    source: 'eval-pko-drop',
    created_at: futureTs,
  });
});

export default scenario;
