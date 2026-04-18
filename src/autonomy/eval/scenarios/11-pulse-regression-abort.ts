/**
 * 11-pulse-regression-abort
 *
 * Entry pulse has mrr_cents=10000. The conductor opens an arc and runs
 * its first phase. The custom executor on this scenario inserts a NEW
 * business_vitals row with mrr_cents=8000 from inside the first impl
 * round (using the shared module-scoped DB handle the harness exposes
 * via the brief's trio_id is too indirect; instead we write directly
 * via a closure over the adapter that the harness sets).
 *
 * Cleaner alternative: the executor synthesises a regression by writing
 * a new business_vitals row through a side-channel `dbInjector` that
 * the harness exposes. We cannot get at the adapter from inside the
 * executor without a globally-scoped seam, so we use the simplest
 * possible path: a global sink that the harness drains before each
 * tick. The scenario sets it before running and clears it after.
 *
 * Mechanism: a `mutateDbHook` that the harness invokes between phase
 * iterations IF defined. The hook receives the adapter and may
 * mutate. The Director then re-reads pulse on the next iteration and
 * the regression check trips.
 *
 * Implementation note for Phase 6: the harness exposes
 * `setMidPhaseHook(scenarioName, hook)` which the executor uses; this
 * keeps the production conductor untouched. The hook fires AFTER each
 * `runPhase` returns, BEFORE the next picker call.
 */
import { defaultMakeStubExecutor } from '../../conductor.js';
import type { RoundBrief, RoundExecutor, RoundReturn } from '../../types.js';
import { setMidArcHook } from '../mid-arc-hook.js';
import type { Scenario } from '../types.js';

class RecordsRegressionExecutor implements RoundExecutor {
  private readonly fallback = defaultMakeStubExecutor();
  async run(brief: RoundBrief): Promise<RoundReturn> {
    return this.fallback.run(brief);
  }
}

const sharedExecutor = new RecordsRegressionExecutor();

const scenario: Scenario = {
  name: '11-pulse-regression-abort',
  describe:
    'Arc opens with mrr=10000; mid-arc hook drops mrr to 8000; next iteration trips kill_on_pulse_regression and arc aborts pulse-ko.',
  initial_seed: {
    approvals: [
      { id: 'ap_kill', subject: 'fire approval that will abort', age_hours: 6, mode: 'revenue' },
    ],
    business_vitals: { mrr_cents: 10000 },
  },
  steps: [
    { kind: 'tick', note: 'arc opens; mid-arc hook injects mrr=8000; second iteration aborts pulse-ko' },
  ],
  assertions: [
    async (t) => {
      const tick = t.steps[0]?.tick_result;
      if (tick?.arc_status !== 'aborted') {
        throw new Error(
          `expected arc_status=aborted, got ${tick?.arc_status}`,
        );
      }
      if (tick.exit_reason !== 'pulse-ko') {
        throw new Error(
          `expected exit_reason=pulse-ko, got ${tick.exit_reason}`,
        );
      }
    },
    async (t) => {
      // Director's pulse-ko branch closes the arc with status=aborted
      // BEFORE the next phase is started, so we expect at least one
      // phase to have actually completed (status phase-closed) before
      // the abort trips.
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      if (phases.length === 0) {
        throw new Error('expected at least one completed phase before pulse-ko');
      }
    },
  ],
  makeExecutor: () => sharedExecutor,
};

// Register the mid-arc hook for THIS scenario name. The harness checks
// the hook map by scenario name before each picker iteration.
// Idempotent: if the regressed row is already there, do nothing.
setMidArcHook(scenario.name, async (db, ctx) => {
  const { data } = await db
    .from<{ id: string }>('business_vitals')
    .select('id')
    .eq('id', 'vital_regression');
  if ((data ?? []).length > 0) return;
  // Insert a regressed vitals row WITH a ts strictly after the entry
  // row so readPulse (orders by ts DESC LIMIT 1) returns this one.
  // The fake clock advances only on `advance` steps, so we hand-roll
  // a +1ms ts.
  const futureTs = new Date(ctx.now().getTime() + 1).toISOString();
  await db.from('business_vitals').insert({
    id: 'vital_regression',
    workspace_id: ctx.workspace_id,
    ts: futureTs,
    mrr: 8000,
    arr: 96000,
    active_users: null,
    daily_cost_cents: null,
    runway_days: null,
    source: 'eval-regression',
    created_at: futureTs,
  });
});

export default scenario;
