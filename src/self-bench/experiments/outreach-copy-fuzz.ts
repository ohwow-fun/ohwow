/**
 * OutreachCopyFuzzExperiment — Phase 2 fuel for the revenue bucket.
 *
 * buildDraftMessage() in outreach-thermostat.ts is the one function in
 * the repo whose output goes directly to a live revenue channel (X DM
 * / X reply / email). It's already tier-2 with string-literal patch
 * mode — the Layer 4 gate lets patch-author edit the template string
 * contents without touching control flow. But nothing was ever
 * flagging copy regressions in these templates, so the revenue bucket
 * had no fuel to act on.
 *
 * This probe closes that. It calls buildDraftMessage with canonical
 * mock plans for each channel, runs a small invariant set against
 * each output, and emits a warning finding with
 * affected_files=['src/self-bench/experiments/outreach-thermostat.ts']
 * when any invariant fails. patch-author picks it up (slug contains
 * 'outreach' → revenue bucket), drafts a string-literal fix, and the
 * same Layer 4 AST bound that protects other string-literal targets
 * stops the model from changing anything but the template contents.
 *
 * Invariants (each failure is a violation row with a ruleId so
 * evidenceLiteralsAppearInSource accepts short matches):
 *   dm-length         — DM must be ≤ 280 chars (X DM hard limit)
 *   reply-length      — reply must be ≤ 280 chars (X reply limit)
 *   email-subject-len — email subject ≤ 78 chars (practical RFC 5322)
 *   brand-mention     — drafts must mention "ohwow" (brand discipline)
 *   no-em-dash        — drafts must not contain `—` (copywriting rule)
 *   no-please         — drafts must not use "please" (direct tone)
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
  buildDraftMessage,
  type EmailDraft,
  type ChannelPlan,
} from './outreach-thermostat.js';

const CADENCE: ExperimentCadence = { everyMs: 15 * 60 * 1000, runOnBoot: true };
const TARGET = 'src/self-bench/experiments/outreach-thermostat.ts';

interface Violation {
  ruleId: string;
  severity: 'warning' | 'error';
  match: string;
  message: string;
  channel: 'x_dm' | 'x_reply' | 'email';
  field: 'text' | 'subject';
}

export interface OutreachCopyFuzzEvidence extends Record<string, unknown> {
  affected_files: string[];
  violations: Violation[];
  checks_run: number;
  samples: Array<{ channel: string; length: number; preview: string }>;
}

const MOCK_PLAN: ChannelPlan = {
  contact_id: 'c1',
  display_name: 'Alex',
  channel: 'x_dm',
  reason: 'fuzz',
  handle: 'alex',
  permalink: null,
  bucket: 'market_signal',
  x_user_id: 'xu1',
  conversation_pair: null,
  email: null,
};

export class OutreachCopyFuzzExperiment implements Experiment {
  readonly id = 'outreach-copy-fuzz';
  readonly name = 'Outreach draft-message invariants fuzz';
  readonly category: ExperimentCategory = 'business_outcome';
  readonly hypothesis =
    'The outreach draft-message templates in outreach-thermostat.ts send real copy to live revenue channels. They must stay within platform limits (280 chars for DMs/replies, 78 for email subjects), mention the brand, and follow the repo copywriting rules. Any drift is a revenue-adjacent regression the patch-author can heal via string-literal edits on the already-tier-2 target.';
  readonly cadence = CADENCE;

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const violations: Violation[] = [];
    const samples: OutreachCopyFuzzEvidence['samples'] = [];
    let checks = 0;

    for (const channel of ['x_dm', 'x_reply', 'email'] as const) {
      const out = buildDraftMessage(channel, { ...MOCK_PLAN, channel });
      checks += 1;
      const text = typeof out === 'string' ? out : (out as EmailDraft).text;
      const subject = typeof out === 'string' ? null : (out as EmailDraft).subject;
      samples.push({ channel, length: text.length, preview: text.slice(0, 60) });

      const limitForChannel = channel === 'email' ? 4000 : 280;
      const lenRule = channel === 'x_dm' ? 'dm-length' : channel === 'x_reply' ? 'reply-length' : 'email-body-length';
      if (text.length > limitForChannel) {
        violations.push({
          ruleId: lenRule,
          severity: 'warning',
          match: text.slice(0, 40),
          message: `${channel} draft is ${text.length} chars (limit ${limitForChannel})`,
          channel,
          field: 'text',
        });
      }
      if (!text.toLowerCase().includes('ohwow')) {
        violations.push({
          ruleId: 'brand-mention',
          severity: 'warning',
          match: text.slice(0, 40),
          message: `${channel} draft does not mention "ohwow"`,
          channel,
          field: 'text',
        });
      }
      if (text.includes('\u2014')) {
        violations.push({
          ruleId: 'no-em-dash',
          severity: 'warning',
          match: '\u2014',
          message: `${channel} draft contains em-dash — use a period, comma, or line break`,
          channel,
          field: 'text',
        });
      }
      if (/\bplease\b/i.test(text)) {
        violations.push({
          ruleId: 'no-please',
          severity: 'warning',
          match: 'please',
          message: `${channel} draft uses "please" — prefer a direct tone`,
          channel,
          field: 'text',
        });
      }
      if (subject) {
        checks += 1;
        if (subject.length > 78) {
          violations.push({
            ruleId: 'email-subject-len',
            severity: 'warning',
            match: subject,
            message: `email subject is ${subject.length} chars (limit 78)`,
            channel,
            field: 'subject',
          });
        }
      }
    }

    const evidence: OutreachCopyFuzzEvidence = {
      affected_files: [TARGET],
      violations,
      checks_run: checks,
      samples,
    };

    const summary = [
      `Result: ran ${checks} invariant check(s) against outreach-thermostat draft templates; ${violations.length} violation(s).`,
      `Threshold: any violation = warning. Patch-author routes through the revenue bucket (slug contains "outreach") and heals via string-literal edits on the tier-2 target.`,
      violations.length === 0
        ? 'Conclusion: outreach copy templates pass all invariants; no action needed.'
        : `Conclusion: ${violations.length} template regression(s) — top: ${violations[0].channel}/${violations[0].ruleId}. Revenue-adjacent fuel for patch-author.`,
    ].join('\n');

    return { subject: 'outreach-copy:drafts', summary, evidence };
  }

  judge(result: ProbeResult, _h: Finding[]): Verdict {
    const ev = result.evidence as OutreachCopyFuzzEvidence;
    if (!ev.violations || ev.violations.length === 0) return 'pass';
    return ev.violations.some((v) => v.severity === 'error') ? 'fail' : 'warning';
  }
}
