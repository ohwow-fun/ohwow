/**
 * OutreachThermostatExperiment — Phase 2 of the sales loop.
 *
 * The first experiment that turns a qualified contact into a concrete
 * outbound proposal. Given:
 *
 *   - an `agent_workforce_goals` row with
 *     target_metric='qualified_first_touches_per_week'
 *   - a pool of contacts with a recent `x:qualified` event that haven't
 *     been reached yet (no outreach:proposed / dm:sent / email:sent /
 *     x:reached inside the cooldown window)
 *
 * ...the thermostat computes a daily budget toward the weekly target,
 * picks a channel per contact (DM if we have `custom_fields.x_user_id`,
 * otherwise a reply on their most recent known post), drafts a short
 * first-touch message from a template, and pushes the draft to the
 * workspace's `x-approvals.jsonl` with `autoApproveAfter=Infinity`.
 *
 * v1 is ALWAYS a proposal — nothing sends without operator approval.
 * That's the safety doctrine: hard caps (daily, per-contact, per-tick)
 * are the substitute for rollback, and the operator stays in the loop
 * for every outbound. Once 10 approvals have landed and rejection rate
 * is under 30%, a future iteration can flip autoApproveAfter to
 * a finite trust threshold.
 *
 * Kill switches
 * -------------
 * - File: `~/.ohwow/outreach-thermostat-disabled` (opt-out, file present = off)
 * - Runtime config: `outreach.thermostat_paused` (set by validate() on
 *   3 consecutive high-rejection windows)
 * - Config default: `outreachThermostatEnabled=false` via the daemon
 *   registrar (this file doesn't read config directly — the daemon
 *   only constructs the experiment when the flag is on)
 *
 * Hard caps (each is a runtime_config knob with a safe default)
 * ------------------------------------------------------------
 * - outreach.max_proposals_per_tick   — default 3
 * - outreach.daily_hard_cap_touches   — default 10
 * - outreach.per_contact_cooldown_hours — default 72
 * - outreach.first_touch_delay_hours  — default 24 (min age of a qualified
 *   contact before first touch; prevents same-hour qualified→proposed
 *   bursts that would look automated from the outside)
 *
 * Validate / rollback
 * -------------------
 * 24h after a batch lands, the experiment reads the approvals queue to
 * see which proposals were approved vs rejected. Three consecutive runs
 * with rejection rate > 30% flip `outreach.thermostat_paused=true`
 * (effectively the rollback — no new proposals until the operator
 * clears the flag). Reversal is 'failed' in ValidationOutcome terms.
 * The "reversal" IS setting the pause flag, so rollback() is a no-op.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';
import { parseSqliteTimestamp } from '../../lib/sqlite-time.js';
import {
  BusinessExperiment,
  type BusinessExperimentOptions,
} from '../business-experiment.js';
import type {
  ExperimentCadence,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  ValidationResult,
  Verdict,
} from '../experiment-types.js';
import { getRuntimeConfig, setRuntimeConfig } from '../runtime-config.js';
import {
  proposeApproval,
  readApprovalRows,
  type ApprovalEntry,
} from '../../scheduling/approval-queue.js';
import { isContactInCooldown, resolveCooldownHours } from '../../lib/outreach-policy.js';
import { voiceCheck } from '../../lib/voice/voice-core.js';

const CADENCE: ExperimentCadence = {
  everyMs: 30 * 60 * 1000,
  runOnBoot: false,
  validationDelayMs: 24 * 60 * 60 * 1000,
};

export const OUTREACH_GOAL_METRIC = 'qualified_first_touches_per_week';
export const OUTREACH_THERMOSTAT_DISABLED_PATH = path.join(
  os.homedir(),
  '.ohwow',
  'outreach-thermostat-disabled',
);

/** Runtime-config keys the thermostat consumes. */
export const THERMOSTAT_CONFIG_KEYS = {
  paused: 'outreach.thermostat_paused',
  maxProposalsPerTick: 'outreach.max_proposals_per_tick',
  dailyHardCap: 'outreach.daily_hard_cap_touches',
  firstTouchDelayHours: 'outreach.first_touch_delay_hours',
} as const;

const DEFAULTS = {
  maxProposalsPerTick: 3,
  dailyHardCap: 10,
  firstTouchDelayHours: 24,
  rejectionWarnFraction: 0.3,
  consecutiveBadRunsToPause: 3,
} as const;

/** Channels the thermostat can schedule. */
export type OutreachChannel = 'x_dm' | 'x_reply' | 'email' | 'none';

interface ContactRow {
  id: string;
  name: string | null;
  email: string | null;
  custom_fields: string | null;
}

interface EventRow {
  id: string;
  contact_id: string | null;
  kind: string | null;
  occurred_at: string | null;
  created_at: string | null;
  payload: string | null;
}

export interface ChannelPlan {
  contact_id: string;
  display_name: string;
  channel: OutreachChannel;
  reason: string;
  handle: string | null;
  permalink: string | null;
  bucket: string | null;
  x_user_id: string | null;
  conversation_pair: string | null;
  email: string | null;
}

export interface ThermostatEvidence extends Record<string, unknown> {
  reason?: 'kill_switch' | 'paused' | 'no_goal' | 'goal_met' | 'nothing_to_do' | 'infeasible';
  goal_id?: string;
  goal_title?: string;
  target_value?: number;
  current_value?: number;
  completed_this_week?: number;
  days_remaining_in_week?: number;
  daily_budget?: number;
  daily_hard_cap?: number;
  proposals_last_24h?: number;
  pending_approvals?: number;
  qualified_pool_size?: number;
  channel_plans?: ChannelPlan[];
  __tracked_field?: 'qualified_pool_size';
}

const HIT_EVENT_KINDS = new Set([
  'outreach:proposed',
  'x:reached',
  'dm:sent',
  'email:sent',
  'dm_received', // inbound — counts as a hit so we don't re-reach a chatting contact
]);

function isKillSwitchDisabled(): boolean {
  try {
    return fs.existsSync(OUTREACH_THERMOSTAT_DISABLED_PATH);
  } catch {
    return false;
  }
}

function parseCustomFields(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function pickChannel(
  cf: Record<string, unknown>,
  email: string | null,
  contactEvents: EventRow[],
  cooldownMs: number,
): { channel: OutreachChannel; reason: string } {
  const xUserId = typeof cf.x_user_id === 'string' && cf.x_user_id.length > 0 ? cf.x_user_id : null;
  const permalink = typeof cf.x_permalink === 'string' ? cf.x_permalink : null;
  const now = Date.now();
  const recentReach = contactEvents
    .filter((e) => e.kind === 'x:reached' || e.kind === 'dm:sent' || e.kind === 'email:sent')
    .map((e) => parseSqliteTimestamp(e.occurred_at ?? e.created_at ?? ''))
    .filter((t) => Number.isFinite(t) && now - t < cooldownMs);

  // DM is the most intimate / highest-signal channel — prefer it when
  // available and fresh. Email second (high reliability, low rate
  // limits). X reply last (most public, more noise).
  if (xUserId && recentReach.length === 0) {
    return { channel: 'x_dm', reason: 'has_x_user_id' };
  }
  if (email && recentReach.length === 0) {
    return { channel: 'email', reason: xUserId ? 'dm_in_cooldown_fallback_email' : 'has_email' };
  }
  if (permalink) {
    return { channel: 'x_reply', reason: xUserId ? 'dm_in_cooldown_fallback_reply' : 'has_permalink' };
  }
  return { channel: 'none', reason: 'no_reach_channel' };
}

export interface EmailDraft {
  subject: string;
  text: string;
}

export function buildDraftMessage(channel: OutreachChannel, plan: ChannelPlan): string | EmailDraft {
  const name = plan.display_name || plan.handle || 'there';
  const bucket = plan.bucket;
  const bucketSubject = bucket === 'market_signal'
    ? 'workflow problem you described'
    : bucket === 'competitors'
      ? 'stack tradeoff you laid out'
      : 'thread you posted';
  if (channel === 'x_dm') {
    return `Saw ${bucketSubject}. Exactly what ohwow is built around. Worth a quick chat`;
  }
  if (channel === 'x_reply') {
    return `Handoff design matters more than agent choice here. ohwow takes a different angle on that tradeoff`;
  }
  if (channel === 'email') {
    return {
      subject: `${name}, on your ${bucket === 'market_signal' ? 'workflow' : bucket === 'competitors' ? 'stack' : 'recent'} post`,
      text: `Saw ${bucketSubject}. Exactly the problem ohwow is built around. Worth a look at the angle ohwow takes on it.\n\nJesus Onoro\nohwow.fun`,
    };
  }
  return '';
}

function startOfIsoWeek(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

function endOfIsoWeek(now: Date): Date {
  const start = startOfIsoWeek(now);
  start.setUTCDate(start.getUTCDate() + 7);
  return start;
}

export interface OutreachThermostatOptions extends BusinessExperimentOptions {
  /**
   * Absolute path to the workspace's x-approvals.jsonl file. Required
   * for intervene() to propose. Tests inject a temp path; production
   * plumbs `workspaceLayoutFor(workspaceSlug).dataDir` from the daemon
   * registrar.
   */
  approvalsJsonlPath: string;
  /**
   * Override for kill-switch detection. Tests use this to simulate the
   * disabled file without touching $HOME. Default: file exists check.
   */
  isKillSwitchDisabled?: () => boolean;
}

export class OutreachThermostatExperiment extends BusinessExperiment {
  readonly id = 'outreach-thermostat';
  readonly name = 'Outreach thermostat (first-touch proposer)';
  readonly hypothesis =
    `When an active goal with target_metric='${OUTREACH_GOAL_METRIC}' is behind its required daily pace, proposing first-touches for qualified contacts that haven't been reached within the cooldown window moves current_value toward the target. Validated 24h later by rejection rate; paused after three consecutive bad runs.`;
  readonly cadence = CADENCE;
  private readonly approvalsJsonlPath: string;
  private readonly killSwitchCheck: () => boolean;

  constructor(opts: OutreachThermostatOptions) {
    super(opts);
    this.approvalsJsonlPath = opts.approvalsJsonlPath;
    this.killSwitchCheck = opts.isKillSwitchDisabled ?? isKillSwitchDisabled;
  }

  protected async businessProbe(ctx: ExperimentContext): Promise<ProbeResult> {
    if (this.killSwitchCheck()) {
      return {
        subject: null,
        summary: 'kill switch file present; thermostat is disabled',
        evidence: { reason: 'kill_switch', channel_plans: [] } satisfies ThermostatEvidence,
      };
    }
    if (getRuntimeConfig<boolean>(THERMOSTAT_CONFIG_KEYS.paused, false)) {
      return {
        subject: null,
        summary: 'thermostat paused by prior validation failure; operator must clear outreach.thermostat_paused',
        evidence: { reason: 'paused', channel_plans: [] } satisfies ThermostatEvidence,
      };
    }

    const goal = await this.findActiveGoalByMetric(ctx, OUTREACH_GOAL_METRIC);
    if (!goal) {
      return {
        subject: null,
        summary: `no active goal with target_metric='${OUTREACH_GOAL_METRIC}' — nothing to tune toward`,
        evidence: { reason: 'no_goal', channel_plans: [] } satisfies ThermostatEvidence,
      };
    }

    const now = new Date();
    const weekStart = startOfIsoWeek(now);
    const weekEnd = endOfIsoWeek(now);
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysRemaining = Math.max(0.25, (weekEnd.getTime() - now.getTime()) / msPerDay);
    const completedThisWeek = Number(goal.currentValue ?? 0);
    const targetValue = Number(goal.targetValue ?? 0);
    const dailyHardCap = Math.max(1, getRuntimeConfig<number>(THERMOSTAT_CONFIG_KEYS.dailyHardCap, DEFAULTS.dailyHardCap));
    const rawDailyBudget = Math.max(0, (targetValue - completedThisWeek) / daysRemaining);
    const dailyBudget = Math.min(dailyHardCap, Math.ceil(rawDailyBudget));

    if (rawDailyBudget > dailyHardCap) {
      return {
        subject: `goal:${goal.id}`,
        summary: `goal '${goal.title}' requires ${rawDailyBudget.toFixed(1)}/day but cap is ${dailyHardCap}; infeasible this week`,
        evidence: {
          reason: 'infeasible',
          goal_id: goal.id,
          goal_title: goal.title,
          target_value: targetValue,
          current_value: completedThisWeek,
          completed_this_week: completedThisWeek,
          days_remaining_in_week: Math.round(daysRemaining * 10) / 10,
          daily_budget: Math.ceil(rawDailyBudget),
          daily_hard_cap: dailyHardCap,
          channel_plans: [],
          qualified_pool_size: 0,
          __tracked_field: 'qualified_pool_size',
        } satisfies ThermostatEvidence,
      };
    }

    if (dailyBudget <= 0) {
      return {
        subject: `goal:${goal.id}`,
        summary: `goal '${goal.title}' ahead of pace at ${completedThisWeek}/${targetValue}`,
        evidence: {
          reason: 'goal_met',
          goal_id: goal.id,
          goal_title: goal.title,
          target_value: targetValue,
          current_value: completedThisWeek,
          completed_this_week: completedThisWeek,
          days_remaining_in_week: Math.round(daysRemaining * 10) / 10,
          daily_budget: 0,
          daily_hard_cap: dailyHardCap,
          channel_plans: [],
          qualified_pool_size: 0,
          __tracked_field: 'qualified_pool_size',
        } satisfies ThermostatEvidence,
      };
    }

    // Cooldown hours come from the shared outreach-policy helper so
    // the thermostat's pool scan uses the same window any downstream
    // dispatcher will re-check with. Scan with the default; per-plan
    // channel-specific overrides get applied at intervene time.
    const cooldownHours = resolveCooldownHours('any');
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    const firstTouchDelayHours = Math.max(0, getRuntimeConfig<number>(
      THERMOSTAT_CONFIG_KEYS.firstTouchDelayHours,
      DEFAULTS.firstTouchDelayHours,
    ));
    const firstTouchMinAgeMs = firstTouchDelayHours * 60 * 60 * 1000;

    const windowStartIso = new Date(now.getTime() - 14 * msPerDay).toISOString();
    let recentEvents: EventRow[] = [];
    try {
      const res = await (ctx.db as DatabaseAdapter)
        .from<EventRow>('agent_workforce_contact_events')
        .select('id, contact_id, kind, occurred_at, created_at, payload')
        .eq('workspace_id', ctx.workspaceId)
        .gte('created_at', windowStartIso);
      recentEvents = ((res as { data?: EventRow[] | null }).data ?? []) as EventRow[];
    } catch (err) {
      logger.warn({ err }, '[outreach-thermostat] event read failed');
    }

    const eventsByContact = new Map<string, EventRow[]>();
    for (const e of recentEvents) {
      if (!e.contact_id) continue;
      const list = eventsByContact.get(e.contact_id);
      if (list) list.push(e);
      else eventsByContact.set(e.contact_id, [e]);
    }

    const qualifiedContactIds: Array<{ contactId: string; qualifiedAtMs: number }> = [];
    for (const [contactId, events] of eventsByContact) {
      const qualifiedEvent = events
        .filter((e) => e.kind === 'x:qualified')
        .sort((a, b) => (a.occurred_at ?? '') < (b.occurred_at ?? '') ? -1 : 1)[0];
      if (!qualifiedEvent) continue;
      const qualifiedAtMs = parseSqliteTimestamp(qualifiedEvent.occurred_at ?? qualifiedEvent.created_at ?? '');
      if (!Number.isFinite(qualifiedAtMs)) continue;
      if (now.getTime() - qualifiedAtMs < firstTouchMinAgeMs) continue;
      const hasHit = events.some((e) => {
        if (!e.kind || !HIT_EVENT_KINDS.has(e.kind)) return false;
        const t = parseSqliteTimestamp(e.occurred_at ?? e.created_at ?? '');
        if (!Number.isFinite(t)) return false;
        return t >= qualifiedAtMs && now.getTime() - t < cooldownMs;
      });
      if (hasHit) continue;
      qualifiedContactIds.push({ contactId, qualifiedAtMs });
    }
    qualifiedContactIds.sort((a, b) => a.qualifiedAtMs - b.qualifiedAtMs);

    if (qualifiedContactIds.length === 0) {
      return {
        subject: `goal:${goal.id}`,
        summary: `goal '${goal.title}': daily budget ${dailyBudget}/day but no qualified contacts outside cooldown`,
        evidence: {
          reason: 'nothing_to_do',
          goal_id: goal.id,
          goal_title: goal.title,
          target_value: targetValue,
          current_value: completedThisWeek,
          completed_this_week: completedThisWeek,
          days_remaining_in_week: Math.round(daysRemaining * 10) / 10,
          daily_budget: dailyBudget,
          daily_hard_cap: dailyHardCap,
          channel_plans: [],
          qualified_pool_size: 0,
          __tracked_field: 'qualified_pool_size',
        } satisfies ThermostatEvidence,
      };
    }

    let contacts: ContactRow[] = [];
    try {
      const res = await (ctx.db as DatabaseAdapter)
        .from<ContactRow>('agent_workforce_contacts')
        .select('id, name, email, custom_fields')
        .eq('workspace_id', ctx.workspaceId)
        .in('id', qualifiedContactIds.map((q) => q.contactId));
      contacts = ((res as { data?: ContactRow[] | null }).data ?? []) as ContactRow[];
    } catch (err) {
      logger.warn({ err }, '[outreach-thermostat] contact read failed');
    }
    const contactById = new Map(contacts.map((c) => [c.id, c]));

    const dayAgoIso = new Date(now.getTime() - msPerDay).toISOString();
    const proposalsLast24h = recentEvents.filter(
      (e) => e.kind === 'outreach:proposed' && (e.occurred_at ?? e.created_at ?? '') >= dayAgoIso,
    ).length;

    const approvals = readApprovalRows(this.approvalsJsonlPath);
    const pendingContactIds = new Set<string>();
    let pendingApprovalCount = 0;
    for (const a of approvals) {
      if (a.status !== 'pending' && a.status !== 'approved' && a.status !== 'auto_applied') continue;
      if (a.kind !== 'x_dm_outbound' && a.kind !== 'x_outbound_reply') continue;
      const contactId = typeof a.payload?.contact_id === 'string' ? a.payload.contact_id : null;
      if (contactId) pendingContactIds.add(contactId);
      if (a.status === 'pending') pendingApprovalCount++;
    }

    const plans: ChannelPlan[] = [];
    for (const { contactId } of qualifiedContactIds) {
      if (pendingContactIds.has(contactId)) continue;
      const contact = contactById.get(contactId);
      if (!contact) continue;
      const cf = parseCustomFields(contact.custom_fields);
      const { channel, reason } = pickChannel(cf, contact.email, eventsByContact.get(contactId) ?? [], cooldownMs);
      if (channel === 'none') continue;
      plans.push({
        contact_id: contactId,
        display_name: contact.name ?? String(cf.x_handle ?? 'there'),
        channel,
        reason,
        handle: typeof cf.x_handle === 'string' ? cf.x_handle : null,
        permalink: typeof cf.x_permalink === 'string' ? cf.x_permalink : null,
        bucket: typeof cf.x_bucket === 'string' ? cf.x_bucket : null,
        x_user_id: typeof cf.x_user_id === 'string' ? cf.x_user_id : null,
        conversation_pair: typeof cf.x_dm_conversation_pair === 'string' ? cf.x_dm_conversation_pair : null,
        email: contact.email,
      });
    }

    return {
      subject: `goal:${goal.id}`,
      summary: `goal '${goal.title}': budget ${dailyBudget}/day, pool ${plans.length}, pending ${pendingApprovalCount}, 24h proposals ${proposalsLast24h}`,
      evidence: {
        goal_id: goal.id,
        goal_title: goal.title,
        target_value: targetValue,
        current_value: completedThisWeek,
        completed_this_week: completedThisWeek,
        days_remaining_in_week: Math.round(daysRemaining * 10) / 10,
        daily_budget: dailyBudget,
        daily_hard_cap: dailyHardCap,
        proposals_last_24h: proposalsLast24h,
        pending_approvals: pendingApprovalCount,
        qualified_pool_size: plans.length,
        channel_plans: plans,
        __tracked_field: 'qualified_pool_size',
      } satisfies ThermostatEvidence,
    };
  }

  protected businessJudge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ThermostatEvidence;
    if (ev.reason === 'infeasible') return 'fail';
    if (ev.reason === 'kill_switch' || ev.reason === 'paused' || ev.reason === 'no_goal' || ev.reason === 'goal_met' || ev.reason === 'nothing_to_do') {
      return 'pass';
    }
    const pool = ev.qualified_pool_size ?? 0;
    const budget = ev.daily_budget ?? 0;
    if (budget <= 0 || pool === 0) return 'pass';
    return 'warning';
  }

  protected async businessIntervene(
    verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    if (verdict !== 'warning') return null;
    const ev = result.evidence as ThermostatEvidence;
    const plans = ev.channel_plans ?? [];
    if (plans.length === 0) return null;

    const maxPerTick = Math.max(1, getRuntimeConfig<number>(
      THERMOSTAT_CONFIG_KEYS.maxProposalsPerTick,
      DEFAULTS.maxProposalsPerTick,
    ));
    const dailyHardCap = ev.daily_hard_cap ?? DEFAULTS.dailyHardCap;
    const dailyBudget = ev.daily_budget ?? 0;
    const proposedLast24h = ev.proposals_last_24h ?? 0;
    const remainingToday = Math.max(0, dailyHardCap - proposedLast24h);
    const budgetToday = Math.min(dailyBudget, remainingToday, maxPerTick, plans.length);
    if (budgetToday <= 0) return null;

    const workspace = ctx.workspaceSlug ?? 'default';
    const proposals: Array<{ contactId: string; approvalId: string; channel: OutreachChannel }> = [];
    for (const plan of plans.slice(0, budgetToday)) {
      // Per-proposal cooldown re-check against the shared helper.
      // Probe already filtered with the default window; this second
      // check catches any contact_event inserted since the probe ran
      // (e.g. a concurrent x:reached from the attribution endpoint).
      const policyChannel = plan.channel === 'x_dm' ? 'x_dm' : plan.channel === 'email' ? 'email' : 'x_reply';
      const cooldown = await isContactInCooldown(
        ctx.db as DatabaseAdapter,
        ctx.workspaceId,
        plan.contact_id,
        policyChannel,
      );
      if (cooldown.inCooldown) {
        logger.info(
          {
            contactId: plan.contact_id,
            channel: plan.channel,
            lastEventKind: cooldown.lastEventKind,
            lastEventAt: cooldown.lastEventAt,
          },
          '[outreach-thermostat] dropping proposal; contact now in cooldown',
        );
        continue;
      }
      const draft = buildDraftMessage(plan.channel, plan);
      if (!draft) continue;

      // Voice gate: run voiceCheck on text-only drafts before proposing.
      // Email drafts (EmailDraft object) carry subject + body; check body text.
      // If the gate rejects, log and skip — do not throw.
      const draftText = typeof draft === 'string' ? draft : draft.text;
      const voicePlatform = plan.channel === 'email' ? 'threads' : (plan.channel === 'x_dm' || plan.channel === 'x_reply' ? 'x' : 'threads');
      const voiceResult = voiceCheck(draftText, { platform: voicePlatform, useCase: 'reply' });
      if (!voiceResult.ok) {
        logger.warn(
          { contactId: plan.contact_id, channel: plan.channel, reasons: voiceResult.reasons },
          '[outreach-thermostat] voice gate rejected draft; skipping',
        );
        continue;
      }

      const approvalKind = plan.channel === 'x_dm'
        ? 'x_dm_outbound'
        : plan.channel === 'email'
          ? 'email_outbound'
          : 'x_outbound_reply';
      const approvalPayload: Record<string, unknown> = {
        contact_id: plan.contact_id,
        handle: plan.handle,
        permalink: plan.permalink,
        bucket: plan.bucket,
        channel: plan.channel,
        origin: 'outreach-thermostat',
        needs_personalization: true,
      };
      if (typeof draft === 'string') {
        approvalPayload.text = draft;
      } else {
        approvalPayload.subject = draft.subject;
        approvalPayload.text = draft.text;
        approvalPayload.cta_url = 'https://ohwow.fun/';
      }
      if (plan.channel === 'x_dm' && plan.conversation_pair) {
        approvalPayload.conversation_pair = plan.conversation_pair;
      }
      if (plan.channel === 'email' && plan.email) {
        approvalPayload.to = plan.email;
      }
      let entry: ApprovalEntry;
      try {
        entry = proposeApproval(this.approvalsJsonlPath, {
          kind: approvalKind,
          workspace,
          summary: `first-touch ${plan.channel} to @${plan.handle ?? plan.display_name}`,
          payload: approvalPayload,
          // Infinity autoApproveAfter keeps v1 strictly human-in-loop
          // regardless of accumulated approvals. A future iteration
          // flips this to a finite trust threshold once 10+ approvals
          // land with <30% rejection rate.
          autoApproveAfter: Number.POSITIVE_INFINITY,
          maxPriorRejected: 0,
          bucketBy: 'channel',
        });
      } catch (err) {
        logger.warn({ err, contactId: plan.contact_id }, '[outreach-thermostat] propose failed; skipping');
        continue;
      }

      try {
        const nowIso = new Date().toISOString();
        const eventPayload = {
          channel: plan.channel,
          approval_id: entry.id,
          approval_kind: approvalKind,
          reason: plan.reason,
        };
        const eventPayloadJson = JSON.stringify(eventPayload);
        await (ctx.db as DatabaseAdapter).from('agent_workforce_contact_events').insert({
          id: crypto.randomUUID(),
          workspace_id: ctx.workspaceId,
          contact_id: plan.contact_id,
          kind: 'outreach:proposed',
          source: this.id,
          payload: eventPayloadJson,
          occurred_at: nowIso,
          event_type: 'outreach:proposed',
          title: `outreach:proposed (${plan.channel})`,
          metadata: eventPayloadJson,
          created_at: nowIso,
        });
      } catch (err) {
        logger.warn({ err, contactId: plan.contact_id, approvalId: entry.id }, '[outreach-thermostat] outreach:proposed event insert failed');
      }

      proposals.push({ contactId: plan.contact_id, approvalId: entry.id, channel: plan.channel });
    }

    if (proposals.length === 0) return null;

    return {
      description: `proposed ${proposals.length} first-touch(es) to approval queue`,
      details: {
        proposal_count: proposals.length,
        proposals,
        daily_budget: dailyBudget,
        daily_hard_cap: dailyHardCap,
        remaining_today_before_tick: remainingToday,
        reversible: false,
        cap_window_hours: 24,
      },
    };
  }

  async validate(
    baseline: Record<string, unknown>,
    ctx: ExperimentContext,
  ): Promise<ValidationResult> {
    const proposals = (baseline.proposals as Array<{ approvalId: string; contactId: string; channel: OutreachChannel }> | undefined) ?? [];
    if (proposals.length === 0) {
      return { outcome: 'inconclusive', summary: 'no proposals to validate', evidence: { ...baseline } };
    }
    const approvals = readApprovalRows(this.approvalsJsonlPath);
    const latestById = new Map<string, ApprovalEntry>();
    for (const row of approvals) {
      if (row.id) latestById.set(row.id, row);
    }
    let approved = 0;
    let rejected = 0;
    let stillPending = 0;
    for (const p of proposals) {
      const latest = latestById.get(p.approvalId);
      if (!latest) { stillPending++; continue; }
      if (latest.status === 'approved' || latest.status === 'auto_applied' || latest.status === 'applied') approved++;
      else if (latest.status === 'rejected') rejected++;
      else stillPending++;
    }
    const rated = approved + rejected;
    const rejectionRate = rated === 0 ? 0 : rejected / rated;
    const evidence = {
      proposals: proposals.length,
      approved,
      rejected,
      still_pending: stillPending,
      rejection_rate: Math.round(rejectionRate * 1000) / 1000,
    };

    if (rated === 0) {
      return { outcome: 'inconclusive', summary: 'no proposals rated yet', evidence };
    }
    if (rejectionRate > DEFAULTS.rejectionWarnFraction) {
      const recentFindings = await ctx.recentFindings(this.id, 6);
      const recentRejectionRates = recentFindings
        .map((f) => {
          const vRate = (f.evidence as { rejection_rate?: number }).rejection_rate;
          return typeof vRate === 'number' ? vRate : null;
        })
        .filter((r): r is number => r !== null)
        .slice(0, DEFAULTS.consecutiveBadRunsToPause - 1);
      const consecutiveBad = 1 + recentRejectionRates.filter((r) => r > DEFAULTS.rejectionWarnFraction).length;
      if (consecutiveBad >= DEFAULTS.consecutiveBadRunsToPause) {
        try {
          await setRuntimeConfig(
            ctx.db,
            THERMOSTAT_CONFIG_KEYS.paused,
            true,
            { setBy: this.id },
          );
        } catch (err) {
          logger.warn({ err }, '[outreach-thermostat] failed to set paused flag');
        }
        return {
          outcome: 'failed',
          summary: `rejection rate ${(rejectionRate * 100).toFixed(0)}% for ${consecutiveBad} consecutive runs; paused`,
          evidence: { ...evidence, consecutive_bad_runs: consecutiveBad, paused: true },
        };
      }
      return {
        outcome: 'failed',
        summary: `rejection rate ${(rejectionRate * 100).toFixed(0)}%; watching for ${DEFAULTS.consecutiveBadRunsToPause - consecutiveBad} more before pausing`,
        evidence: { ...evidence, consecutive_bad_runs: consecutiveBad },
      };
    }
    return {
      outcome: 'held',
      summary: `${approved}/${rated} approved (${(rejectionRate * 100).toFixed(0)}% rejection rate)`,
      evidence,
    };
  }

  /**
   * Rollback is a no-op: the thermostat's rollback mechanism IS the
   * pause flag, which validate() has already set. The individual
   * proposals remain in the approval queue for operator review.
   */
  async rollback(): Promise<InterventionApplied | null> {
    return null;
  }
}
