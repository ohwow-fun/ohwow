/**
 * lift-inference — Phase 5b. Maps "this commit touches these files"
 * to a list of Expected-Lift claims, and builds the recorder closure
 * that reads baseline KPIs + writes lift_measurements rows.
 *
 * Separated from the authors (patch-author, experiment-author) so the
 * heuristic is one pure function that's easy to unit-test and cheap
 * to extend: new tier-2 paths plug in one row here and the trailer +
 * baseline row show up on every commit touching them.
 *
 * The heuristics are intentionally coarse. The real credit-assignment
 * signal isn't "did exactly the right KPI move" but "did the loop,
 * over N commits tagged with this KPI, shift the rolling moved_right
 * share upward." Over-tagging (claiming a lift on every marginally
 * related file) would dilute the signal; under-tagging would starve
 * the ranker. Current policy: tag only paths where a downstream KPI
 * connection is concrete and documented, and cap each commit at the
 * first-matching heuristic so a single commit doesn't fan out to 4
 * different KPIs with different horizons.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { readKpi } from './kpi-registry.js';
import {
  insertBaseline,
  type ExpectedLift,
} from './lift-measurements-store.js';
import type { LiftBaselineRecorderInput } from './self-commit.js';

/**
 * File → expected-lift mapping. Evaluated in order; first matcher that
 * intersects the commit's file list owns the commit. Keeps the
 * trailer count small and the credit-assignment signal clear.
 */
export interface LiftHeuristic {
  /** One-sentence description — lands in debug logs + fuzz evidence. */
  description: string;
  /** Regex or path fragment that must match at least one of the commit's files. */
  pathMatches: RegExp;
  /** Lifts to claim when a file matches. Order-preserving on output. */
  lifts: readonly ExpectedLift[];
}

export const LIFT_HEURISTICS: readonly LiftHeuristic[] = Object.freeze([
  // Outreach copy / cooldown policy — the revenue bucket's active
  // surface. A patch here is presumed to move reply rate + qualified
  // events. Three horizons triangulate the signal:
  //   1h   — early ripple on reply_ratio_24h (the 24h window slides by
  //          1/24th; noisy but gives the loop a verdict within the
  //          LiftMeasurementExperiment cadence instead of waiting a day)
  //   24h  — primary reply_ratio check once the full window has turned
  //   168h — qualification downstream (reply → DM → lead → qualified
  //          takes a week to surface)
  {
    description:
      'outreach-policy.ts or outreach-thermostat.ts — changes to cooldown gate + draft templates',
    pathMatches: /src\/(lib\/outreach-policy|self-bench\/experiments\/outreach-thermostat)\.ts$/,
    lifts: [
      { kpiId: 'reply_ratio_24h', direction: 'up', horizonHours: 1 },
      { kpiId: 'reply_ratio_24h', direction: 'up', horizonHours: 24 },
      { kpiId: 'qualified_events_24h', direction: 'up', horizonHours: 168 },
    ],
  },
  // x-dm-dispatch-config.ts — interval + batch knobs for the DM
  // dispatcher. A tune here moves outbound_dm_24h fastest of any tier-2
  // target (it literally sets how many DMs ship per tick), with
  // reply_ratio_24h as the downstream check that the higher rate is
  // actually productive (not just spamming). No qualified_events
  // horizon — the dispatcher doesn't touch qualification.
  {
    description:
      'x-dm-dispatch-config.ts — interval + batch knobs for DM dispatcher',
    pathMatches: /src\/lib\/x-dm-dispatch-config\.ts$/,
    lifts: [
      { kpiId: 'outbound_dm_24h', direction: 'up', horizonHours: 1 },
      { kpiId: 'outbound_dm_24h', direction: 'up', horizonHours: 24 },
      { kpiId: 'reply_ratio_24h', direction: 'up', horizonHours: 24 },
    ],
  },
  // x-authors-to-crm / qualifier scripts — pipeline upstream of the
  // lead flip. Moving these tends to show up in active_leads + qualified
  // events; attribution to revenue takes even longer than the outreach
  // surface, so the main horizon is 7d. A 1h qualified_events_24h read
  // gives an early regression signal if a classifier change is
  // catastrophically worse; active_leads changes too slowly to bother
  // measuring at 1h.
  {
    description:
      'x-authors-to-crm.mjs / _qualify.mjs — qualification pipeline changes',
    pathMatches: /scripts\/x-experiments\/(x-authors-to-crm|_qualify)\.mjs$/,
    lifts: [
      { kpiId: 'qualified_events_24h', direction: 'up', horizonHours: 1 },
      { kpiId: 'active_leads', direction: 'up', horizonHours: 168 },
      { kpiId: 'qualified_events_24h', direction: 'up', horizonHours: 168 },
    ],
  },
]);

/**
 * Return the Expected-Lift list for the first heuristic that matches
 * any of the commit's files. No match → [] (no trailer, no baseline).
 *
 * Pure. Order of filePaths does not matter; matcher order does (first
 * wins to keep trailer noise down).
 */
export function inferExpectedLifts(filePaths: readonly string[]): ExpectedLift[] {
  const normalized = filePaths.map((p) => p.replace(/\\/g, '/'));
  for (const heuristic of LIFT_HEURISTICS) {
    if (normalized.some((p) => heuristic.pathMatches.test(p))) {
      return [...heuristic.lifts];
    }
  }
  return [];
}

/**
 * Factory for the liftBaselineRecorder callback safeSelfCommit expects.
 * Binds the workspace db + id in a closure so the recorder can read
 * the baseline KPI value and insert the lift_measurements row without
 * self-commit.ts having to know about either.
 */
export function buildLiftBaselineRecorder(
  db: DatabaseAdapter,
  workspaceId: string,
): (input: LiftBaselineRecorderInput) => Promise<void> {
  return async (input) => {
    const reading = await readKpi(input.expected.kpiId, { db, workspaceId });
    await insertBaseline(db, {
      workspaceId,
      commitSha: input.commitSha,
      expected: input.expected,
      baselineValue: reading?.value ?? null,
      baselineAt: input.baselineAt,
      sourceExperimentId: input.sourceExperimentId,
    });
  };
}
