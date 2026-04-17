/**
 * BurnGuardExperiment — Phase 2 budget throttle for the money-telos loop.
 *
 * Reads the daily LLM spend from the latest burn-rate finding and
 * compares it to a configured daily cap. When burn exceeds the cap,
 * flips `burn.above_cap` in runtime-config. experiment-author's
 * rankProposals reads that flag and skips the fifo bucket, so
 * priority / roadmap / revenue-keyword proposals keep running but
 * paper-derived observer probes stop getting authored until the
 * next daily reset or the cap is raised.
 *
 * Cap sources (first non-null wins):
 *   1. OHWOW_BURN_DAILY_CAP_CENTS env var (preferred for CI/tests)
 *   2. runtime_config key `burn.daily_cap_cents` (set by operator)
 *   3. null → no enforcement (default; visibility-only like OpsPulse)
 *
 * Verdict:
 *   pass     — no cap set OR burn under cap
 *   warning  — burn within 20% of cap ("about to trip")
 *   fail     — burn over cap (flag flipped, author throttled)
 *
 * Cadence: every 5 minutes. Cheap — one findings read + at most one
 * runtime_config write per tick.
 */

import type {
  Experiment,
  ExperimentCadence,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { listFindings } from '../findings-store.js';
import { getRuntimeConfig, setRuntimeConfig } from '../runtime-config.js';

const CADENCE: ExperimentCadence = { everyMs: 5 * 60 * 1000, runOnBoot: true };

export const BURN_ABOVE_CAP_KEY = 'burn.above_cap';
export const BURN_DAILY_CAP_CENTS_KEY = 'burn.daily_cap_cents';

export interface BurnGuardEvidence extends Record<string, unknown> {
  cap_cents: number | null;
  burn_cents_today: number;
  above_cap: boolean;
  cap_source: 'env' | 'runtime_config' | 'none';
  flag_flipped: boolean;
  headroom_cents: number | null;
}

export function resolveCapCents(): { cap: number | null; source: 'env' | 'runtime_config' | 'none' } {
  const env = process.env.OHWOW_BURN_DAILY_CAP_CENTS;
  if (env && env.trim() !== '') {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return { cap: Math.floor(parsed), source: 'env' };
  }
  const cfg = getRuntimeConfig<number | null>(BURN_DAILY_CAP_CENTS_KEY, null);
  if (typeof cfg === 'number' && Number.isFinite(cfg) && cfg > 0) {
    return { cap: Math.floor(cfg), source: 'runtime_config' };
  }
  return { cap: null, source: 'none' };
}

export class BurnGuardExperiment implements Experiment {
  readonly id = 'burn-guard';
  readonly name = 'Burn guard (daily LLM spend cap)';
  readonly category: ExperimentCategory = 'business_outcome';
  readonly hypothesis =
    'Without a throttle, paper-derived observer probes can outspend the sales loop on an $0-revenue day. A daily cents cap that flips a runtime-config flag on breach lets the ranker keep priority/roadmap/revenue work running while shedding fifo work, preserving money-adjacent throughput without manual intervention.';
  readonly cadence = CADENCE;

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const { cap, source } = resolveCapCents();

    const burnRows = await listFindings(ctx.db, { experimentId: 'burn-rate', limit: 1 });
    const burnEv = burnRows[0]?.evidence as { total_cents_today?: number } | undefined;
    const burn = Number(burnEv?.total_cents_today ?? 0);

    const aboveCap = cap !== null && burn >= cap;
    const prior = getRuntimeConfig<boolean>(BURN_ABOVE_CAP_KEY, false);
    let flipped = false;
    if (cap !== null && prior !== aboveCap) {
      await setRuntimeConfig(ctx.db, BURN_ABOVE_CAP_KEY, aboveCap, { setBy: this.id });
      flipped = true;
    } else if (cap === null && prior !== false) {
      // Cap removed while flag was on — reset so the ranker unthrottles.
      await setRuntimeConfig(ctx.db, BURN_ABOVE_CAP_KEY, false, { setBy: this.id });
      flipped = true;
    }

    const headroom = cap === null ? null : cap - burn;
    const evidence: BurnGuardEvidence = {
      cap_cents: cap,
      burn_cents_today: burn,
      above_cap: aboveCap,
      cap_source: source,
      flag_flipped: flipped,
      headroom_cents: headroom,
    };

    const capStr = cap === null ? 'unset' : `$${(cap / 100).toFixed(2)}`;
    const burnStr = `$${(burn / 100).toFixed(2)}`;
    const summary = [
      `Result: daily burn ${burnStr} vs cap ${capStr} (source=${source}). above_cap=${aboveCap}${flipped ? ' (flag flipped this tick)' : ''}.`,
      'Threshold: fail if burn >= cap; warn if within 20% of cap; pass if under. Null cap = visibility only.',
      cap === null
        ? 'Conclusion: no cap configured; loop is visibility-only. Set OHWOW_BURN_DAILY_CAP_CENTS or the burn.daily_cap_cents runtime-config key to enable throttling.'
        : aboveCap
          ? `Conclusion: over cap; fifo bucket throttled. Only priority/roadmap/revenue proposals author now. Resets at midnight when burn-rate rolls over.`
          : headroom !== null && headroom < cap * 0.2
            ? `Conclusion: within 20% of cap (headroom $${(headroom / 100).toFixed(2)}); one more heavy tick could trip.`
            : `Conclusion: under cap with $${(headroom! / 100).toFixed(2)} headroom; no throttling active.`,
    ].join('\n');

    return { subject: 'meta:burn-guard', summary, evidence };
  }

  judge(result: ProbeResult, _h: Finding[]): Verdict {
    const ev = result.evidence as BurnGuardEvidence;
    if (ev.cap_cents === null) return 'pass';
    if (ev.above_cap) return 'fail';
    if (ev.headroom_cents !== null && ev.headroom_cents < ev.cap_cents * 0.2) return 'warning';
    return 'pass';
  }
}
