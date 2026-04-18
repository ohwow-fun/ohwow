/**
 * Per-mode wall-clock + LLM-cost budgets for the autonomy stack
 * (gap 14.11b).
 *
 * The Director compares each finished phase's `cost_minutes` /
 * `cost_llm_cents` against `MODE_BUDGETS[mode]` and exits the arc with
 * `exit_reason='budget-exceeded'` when either ceiling trips. The Ranker
 * reads back the same constants when deciding whether to demote a mode
 * whose recent arcs blew the cap (see `DEMOTION_*` knobs below).
 *
 * Pure constant module; no DB access.
 */

import type { Mode } from './types.js';

/**
 * Wall-clock minutes + LLM cost ceiling per mode. Tooling gets the
 * largest envelope because forging missing verbs / wiring is the most
 * latency-tolerant work; revenue is the tightest because a stalled
 * approval push burns founder trust the fastest.
 */
export const MODE_BUDGETS: Record<
  Mode,
  { wall_minutes: number; llm_cents: number }
> = {
  revenue: { wall_minutes: 15, llm_cents: 10 },
  polish: { wall_minutes: 90, llm_cents: 50 },
  plumbing: { wall_minutes: 120, llm_cents: 30 },
  tooling: { wall_minutes: 180, llm_cents: 100 },
};

/** Multiplicative penalty applied to a candidate's score when the mode's
 *  recent arcs averaged over the overage threshold. */
export const DEMOTION_MULTIPLIER = 0.7;

/** Number of recent arcs (most-recent first, distinct arc_ids) the
 *  ranker averages cost over when deciding demotion. */
export const DEMOTION_LOOKBACK_ARCS = 3;

/** If average cost across the lookback window exceeds
 *  `MODE_BUDGETS[mode].wall_minutes * DEMOTION_OVERAGE_RATIO`, the mode's
 *  candidates are demoted. */
export const DEMOTION_OVERAGE_RATIO = 1.5;
