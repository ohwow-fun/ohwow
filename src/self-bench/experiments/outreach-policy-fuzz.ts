/**
 * OutreachPolicyFuzzExperiment — Phase 1 fuel for the tier-2 cooldown knob.
 *
 * outreach-policy.ts is the one piece of code every revenue channel
 * consults before sending: "has anyone else already reached this contact
 * recently?" The cooldown hours (default + per-channel overrides) and
 * the event-kind set that counts as a "touch" are the knobs that shape
 * how aggressively the loop can outreach without looking spammy.
 *
 * This probe promotes outreach-policy.ts into the autonomous-fixing
 * loop by running a small invariant set against the live file's
 * exports + resolveCooldownHours() and emitting a finding with
 * affected_files=['src/lib/outreach-policy.ts'] when any invariant
 * fails. patch-author picks it up (slug contains 'outreach' → revenue
 * bucket), drafts a whole-file fix, and the tier-2 Fixes-Finding-Id
 * gate + invariant re-run close the heal cycle.
 *
 * Invariants (each failure is a violation row with a ruleId):
 *   default-range       — DEFAULT_COOLDOWN_HOURS in [1, 720]
 *   resolve-positive    — resolveCooldownHours(channel) > 0 for every
 *                         channel in the OutreachChannel union
 *   override-positive   — resolveCooldownHours(ch, override>0) returns override
 *   override-ignored    — resolveCooldownHours(ch, 0) falls through (matches
 *                         resolveCooldownHours(ch)) rather than returning 0
 *   event-kinds-size    — COOLDOWN_EVENT_KINDS has ≥ 3 entries
 *   event-kinds-core    — COOLDOWN_EVENT_KINDS contains the core touch kinds
 *                         ('dm:sent', 'email:sent', 'dm_received')
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
  COOLDOWN_EVENT_KINDS,
  DEFAULT_COOLDOWN_HOURS,
  resolveCooldownHours,
  type OutreachChannel,
} from '../../lib/outreach-policy.js';

const CADENCE: ExperimentCadence = { everyMs: 30 * 60 * 1000, runOnBoot: true };
const TARGET = 'src/lib/outreach-policy.ts';

const CHANNELS: readonly OutreachChannel[] = ['x_dm', 'x_reply', 'email', 'any'];

/** Event kinds that must be present. Removing any of these would let an
 *  agent DM a contact that just emailed them, which defeats the gate. */
const REQUIRED_EVENT_KINDS: readonly string[] = [
  'dm:sent',
  'email:sent',
  'dm_received',
];

/** Sane bounds on the default cooldown. Tight end stops "0h = no gate"
 *  regressions; loose end stops "1 year = effectively disabled" regressions. */
const DEFAULT_MIN_HOURS = 1;
const DEFAULT_MAX_HOURS = 720;

interface Violation {
  ruleId: string;
  severity: 'warning' | 'error';
  /** Short literal match, satisfies patch-author's literal-in-source check. */
  match: string;
  message: string;
  channel?: OutreachChannel;
}

export interface OutreachPolicyFuzzEvidence extends Record<string, unknown> {
  affected_files: string[];
  violations: Violation[];
  checks_run: number;
  observed: {
    default_cooldown_hours: number;
    event_kinds: string[];
    resolved_by_channel: Array<{ channel: OutreachChannel; hours: number }>;
  };
}

export class OutreachPolicyFuzzExperiment implements Experiment {
  readonly id = 'outreach-policy-fuzz';
  readonly name = 'Outreach cooldown policy invariants fuzz';
  readonly category: ExperimentCategory = 'business_outcome';
  readonly hypothesis =
    'outreach-policy.ts gates every outbound message by asking "did we already touch this contact?" Its DEFAULT_COOLDOWN_HOURS, per-channel resolver, and COOLDOWN_EVENT_KINDS set must stay within sane bounds or the loop either over-spams contacts (too short) or falls silent (too long / missing event kinds). Any drift is a revenue-adjacent regression the patch-author can heal via whole-file edits on this tier-2 target.';
  readonly cadence = CADENCE;

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const violations: Violation[] = [];
    let checks = 0;

    // Rule: default-range
    checks += 1;
    if (
      !Number.isInteger(DEFAULT_COOLDOWN_HOURS) ||
      DEFAULT_COOLDOWN_HOURS < DEFAULT_MIN_HOURS ||
      DEFAULT_COOLDOWN_HOURS > DEFAULT_MAX_HOURS
    ) {
      violations.push({
        ruleId: 'default-range',
        severity: 'warning',
        match: `DEFAULT_COOLDOWN_HOURS`,
        message: `DEFAULT_COOLDOWN_HOURS=${DEFAULT_COOLDOWN_HOURS} is outside sane range [${DEFAULT_MIN_HOURS}, ${DEFAULT_MAX_HOURS}].`,
      });
    }

    // Rule: resolve-positive
    const resolved: Array<{ channel: OutreachChannel; hours: number }> = [];
    for (const ch of CHANNELS) {
      checks += 1;
      const h = resolveCooldownHours(ch);
      resolved.push({ channel: ch, hours: h });
      if (!(typeof h === 'number') || !Number.isFinite(h) || h <= 0) {
        violations.push({
          ruleId: 'resolve-positive',
          severity: 'warning',
          match: `resolveCooldownHours`,
          message: `resolveCooldownHours('${ch}') returned ${h}; must be a positive finite number.`,
          channel: ch,
        });
      }
    }

    // Rule: override-positive
    for (const ch of CHANNELS) {
      checks += 1;
      const h = resolveCooldownHours(ch, 168);
      if (h !== 168) {
        violations.push({
          ruleId: 'override-positive',
          severity: 'warning',
          match: `overrideHours`,
          message: `resolveCooldownHours('${ch}', 168) returned ${h}; positive override must be honored exactly.`,
          channel: ch,
        });
      }
    }

    // Rule: override-ignored — override=0 must fall through, NOT return 0.
    for (const ch of CHANNELS) {
      checks += 1;
      const baseline = resolveCooldownHours(ch);
      const withZero = resolveCooldownHours(ch, 0);
      if (withZero !== baseline) {
        violations.push({
          ruleId: 'override-ignored',
          severity: 'warning',
          match: `overrideHours > 0`,
          message: `resolveCooldownHours('${ch}', 0) returned ${withZero} vs baseline ${baseline}; zero override must be ignored.`,
          channel: ch,
        });
      }
    }

    // Rule: event-kinds-size
    checks += 1;
    if (COOLDOWN_EVENT_KINDS.size < 3) {
      violations.push({
        ruleId: 'event-kinds-size',
        severity: 'warning',
        match: 'COOLDOWN_EVENT_KINDS',
        message: `COOLDOWN_EVENT_KINDS has ${COOLDOWN_EVENT_KINDS.size} entries; expected ≥ 3 to cover cross-channel touches.`,
      });
    }

    // Rule: event-kinds-core
    for (const kind of REQUIRED_EVENT_KINDS) {
      checks += 1;
      if (!COOLDOWN_EVENT_KINDS.has(kind)) {
        violations.push({
          ruleId: 'event-kinds-core',
          severity: 'warning',
          match: kind,
          message: `COOLDOWN_EVENT_KINDS is missing the core touch kind "${kind}"; outbound channels can double-touch contacts.`,
        });
      }
    }

    const evidence: OutreachPolicyFuzzEvidence = {
      affected_files: [TARGET],
      violations,
      checks_run: checks,
      observed: {
        default_cooldown_hours: DEFAULT_COOLDOWN_HOURS,
        event_kinds: [...COOLDOWN_EVENT_KINDS].sort(),
        resolved_by_channel: resolved,
      },
    };

    const summary = [
      `Result: ran ${checks} invariant check(s) against outreach-policy exports; ${violations.length} violation(s). DEFAULT_COOLDOWN_HOURS=${DEFAULT_COOLDOWN_HOURS}.`,
      `Threshold: any violation = warning. Patch-author routes via the revenue bucket (slug contains "outreach") and heals via whole-file edits on the tier-2 target.`,
      violations.length === 0
        ? 'Conclusion: outreach cooldown policy passes all invariants; revenue gate is sane.'
        : `Conclusion: ${violations.length} regression(s) — top: ${violations[0].ruleId} ${violations[0].channel ? `(${violations[0].channel})` : ''}. Revenue-adjacent fuel for patch-author.`,
    ].join('\n');

    return { subject: 'outreach-policy:exports', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as OutreachPolicyFuzzEvidence;
    if (ev.violations.length === 0) return 'pass';
    return 'warning';
  }
}
