/**
 * XDmDispatchConfigFuzzExperiment — Phase 1 continuation fuel for the
 * tier-2 dispatch-cadence knob.
 *
 * x-dm-dispatch-config.ts exports two numbers that shape how
 * aggressively the DM dispatcher drains operator-approved replies:
 * the tick interval and the per-tick send cap. Both have sane ranges
 * — too short and the CDP lane contends itself into timeouts; too
 * long and approvals queue up past the human-tolerable window.
 *
 * This probe runs a small invariant set against the live exports and
 * emits a finding with affected_files=['src/lib/x-dm-dispatch-config.ts']
 * when any invariant fails. patch-author picks it up (slug contains
 * 'x-dm' / 'dispatch' and the tier-2 path matches one of the revenue-
 * proximal prefixes the value-ranker boosts) and drafts a whole-file
 * fix under the Layer 4 single-top-level-symbol gate.
 *
 * Invariants (each failure is a violation row with a ruleId):
 *   interval-type      — DM_DISPATCH_INTERVAL_MS is a finite positive number
 *   interval-floor     — DM_DISPATCH_INTERVAL_MS >= 30_000 (30s; avoids
 *                        rate-limit storms and CDP lane thrashing)
 *   interval-ceiling   — DM_DISPATCH_INTERVAL_MS <= 600_000 (10min;
 *                        backlog-stall tripwire)
 *   batch-type         — DM_DISPATCH_MAX_PER_TICK is a positive integer
 *   batch-floor        — DM_DISPATCH_MAX_PER_TICK >= 1
 *   batch-ceiling      — DM_DISPATCH_MAX_PER_TICK <= 20 (caps the
 *                        blast radius of a bad send cascade)
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
import {
  DM_DISPATCH_INTERVAL_MS,
  DM_DISPATCH_MAX_PER_TICK,
} from '../../lib/x-dm-dispatch-config.js';

const CADENCE: ExperimentCadence = { everyMs: 30 * 60 * 1000, runOnBoot: true };
const TARGET = 'src/lib/x-dm-dispatch-config.ts';

/** Tighter-than-useful floor blocks rate-limit storms; looser-than-
 *  current ceiling leaves the loop room to tune. */
const INTERVAL_MIN_MS = 30_000;
const INTERVAL_MAX_MS = 10 * 60 * 1000;
/** Batch caps: a per-tick batch smaller than 1 is useless; larger than
 *  20 turns one bad navigation into a systemic stall. */
const BATCH_MIN = 1;
const BATCH_MAX = 20;

interface Violation {
  ruleId: string;
  severity: 'warning' | 'error';
  /** Short literal match so patch-author's literal-in-source check finds it. */
  match: string;
  message: string;
}

export interface XDmDispatchConfigFuzzEvidence extends Record<string, unknown> {
  affected_files: string[];
  violations: Violation[];
  checks_run: number;
  observed: {
    interval_ms: number;
    max_per_tick: number;
  };
}

export class XDmDispatchConfigFuzzExperiment implements Experiment {
  readonly id = 'x-dm-dispatch-config-fuzz';
  readonly name = 'X DM dispatch cadence + batch-size invariants fuzz';
  readonly category: ExperimentCategory = 'business_outcome';
  readonly hypothesis =
    'x-dm-dispatch-config.ts exports DM_DISPATCH_INTERVAL_MS and DM_DISPATCH_MAX_PER_TICK — the tick interval and per-tick batch cap that shape how quickly operator-approved DMs ship. Both have sane ranges: too short (CDP lane contention, rate-limit storms) or too long (approval → send stall) hurts outbound_dm_24h and downstream reply_ratio_24h. Any drift outside those ranges is a revenue-adjacent regression the patch-author can heal via whole-file edits on this tier-2 target.';
  readonly cadence = CADENCE;

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const violations: Violation[] = [];
    let checks = 0;

    // Rule: interval-type
    checks += 1;
    if (!Number.isFinite(DM_DISPATCH_INTERVAL_MS) || DM_DISPATCH_INTERVAL_MS <= 0) {
      violations.push({
        ruleId: 'interval-type',
        severity: 'warning',
        match: 'DM_DISPATCH_INTERVAL_MS',
        message: `DM_DISPATCH_INTERVAL_MS=${DM_DISPATCH_INTERVAL_MS} is not a positive finite number.`,
      });
    }

    // Rule: interval-floor
    checks += 1;
    if (Number.isFinite(DM_DISPATCH_INTERVAL_MS) && DM_DISPATCH_INTERVAL_MS < INTERVAL_MIN_MS) {
      violations.push({
        ruleId: 'interval-floor',
        severity: 'warning',
        match: 'DM_DISPATCH_INTERVAL_MS',
        message: `DM_DISPATCH_INTERVAL_MS=${DM_DISPATCH_INTERVAL_MS}ms is below the ${INTERVAL_MIN_MS}ms floor; CDP lane contention + rate-limit risk.`,
      });
    }

    // Rule: interval-ceiling
    checks += 1;
    if (Number.isFinite(DM_DISPATCH_INTERVAL_MS) && DM_DISPATCH_INTERVAL_MS > INTERVAL_MAX_MS) {
      violations.push({
        ruleId: 'interval-ceiling',
        severity: 'warning',
        match: 'DM_DISPATCH_INTERVAL_MS',
        message: `DM_DISPATCH_INTERVAL_MS=${DM_DISPATCH_INTERVAL_MS}ms is above the ${INTERVAL_MAX_MS}ms ceiling; approval → send stall risk.`,
      });
    }

    // Rule: batch-type
    checks += 1;
    if (!Number.isInteger(DM_DISPATCH_MAX_PER_TICK) || DM_DISPATCH_MAX_PER_TICK <= 0) {
      violations.push({
        ruleId: 'batch-type',
        severity: 'warning',
        match: 'DM_DISPATCH_MAX_PER_TICK',
        message: `DM_DISPATCH_MAX_PER_TICK=${DM_DISPATCH_MAX_PER_TICK} is not a positive integer.`,
      });
    }

    // Rule: batch-floor
    checks += 1;
    if (Number.isFinite(DM_DISPATCH_MAX_PER_TICK) && DM_DISPATCH_MAX_PER_TICK < BATCH_MIN) {
      violations.push({
        ruleId: 'batch-floor',
        severity: 'warning',
        match: 'DM_DISPATCH_MAX_PER_TICK',
        message: `DM_DISPATCH_MAX_PER_TICK=${DM_DISPATCH_MAX_PER_TICK} is below the ${BATCH_MIN} floor; dispatcher is effectively disabled.`,
      });
    }

    // Rule: batch-ceiling
    checks += 1;
    if (Number.isFinite(DM_DISPATCH_MAX_PER_TICK) && DM_DISPATCH_MAX_PER_TICK > BATCH_MAX) {
      violations.push({
        ruleId: 'batch-ceiling',
        severity: 'warning',
        match: 'DM_DISPATCH_MAX_PER_TICK',
        message: `DM_DISPATCH_MAX_PER_TICK=${DM_DISPATCH_MAX_PER_TICK} is above the ${BATCH_MAX} ceiling; one stuck send cascades across the whole tick.`,
      });
    }

    const evidence: XDmDispatchConfigFuzzEvidence = {
      affected_files: [TARGET],
      violations,
      checks_run: checks,
      observed: {
        interval_ms: DM_DISPATCH_INTERVAL_MS,
        max_per_tick: DM_DISPATCH_MAX_PER_TICK,
      },
    };

    const summary = [
      `Result: ran ${checks} invariant check(s) against x-dm-dispatch-config; ${violations.length} violation(s). interval=${DM_DISPATCH_INTERVAL_MS}ms batch=${DM_DISPATCH_MAX_PER_TICK}.`,
      `Threshold: any violation = warning. Patch-author routes via the revenue bucket (path in value-ranker's revenue-proximal list) and heals via whole-file edits on the tier-2 target.`,
      violations.length === 0
        ? 'Conclusion: DM dispatch cadence + batch cap pass all invariants; send-rate knobs are sane.'
        : `Conclusion: ${violations.length} regression(s) — top: ${violations[0].ruleId}. Revenue-adjacent fuel for patch-author.`,
    ].join('\n');

    return { subject: 'x-dm-dispatch-config:exports', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as XDmDispatchConfigFuzzEvidence;
    if (ev.violations.length === 0) return 'pass';
    return 'warning';
  }
}
