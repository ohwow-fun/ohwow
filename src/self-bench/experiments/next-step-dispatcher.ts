/**
 * NextStepDispatcher — routes open next_step events into loop actions.
 *
 * The analyst produces `next_step` events with step_type +
 * suggested_action. This probe picks up those events while status='open'
 * and routes each one to the appropriate actuator:
 *
 * - bug_report       → emit an experiment-proposal finding so the
 *                      patch/author loops pick it up as something to
 *                      investigate; mark 'dispatched'.
 * - feature_request  → emit an experiment-proposal finding tagged as
 *                      a feature request; mark 'dispatched'.
 * - question         → create a needs_approval task titled
 *                      "Reply to <contact>: <first 40c>" with the
 *                      LLM-suggested draft as description; mark
 *                      'dispatched'.
 * - follow_up        → same as question but the task title reflects
 *                      a nudge rather than an answer.
 * - sentiment        → no action; mark 'ignored'.
 * - nothing          → mark 'ignored'.
 *
 * Status tracking lives inside the next_step event's payload JSON.
 * The dispatcher re-reads it every tick and only acts on status='open'
 * rows. This keeps the contract between analyst and dispatcher
 * entirely in the contact_events table — no new schema.
 *
 * Verdict
 * -------
 * - warning: at least one step dispatched
 * - pass:    nothing to do OR only ignores
 * - fail:    errors > half of attempts
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import {
  proposeReplyFromNextStep,
  reconcileShippedNextSteps,
} from '../../lib/dm-reply-queue.js';
import { logger } from '../../lib/logger.js';
import {
  BusinessExperiment,
  type BusinessExperimentOptions,
} from '../business-experiment.js';
import type {
  ExperimentCadence,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { writeFinding } from '../findings-store.js';
import type { NextStepPayload, NextStepStatus, NextStepType } from './contact-conversation-analyst.js';

const MINUTE_MS = 60 * 1000;
const DEFAULT_INTERVAL_MS = 5 * MINUTE_MS;
const DEFAULT_MAX_PER_TICK = 10;

interface OpenNextStep {
  eventId: string;
  contactId: string;
  contactName: string;
  createdAt: string;
  payload: NextStepPayload;
}

interface DispatchResult {
  eventId: string;
  contactName: string;
  step_type: NextStepType;
  outcome: 'dispatched' | 'ignored' | 'error';
  action?: string;
  error?: string;
}

export class NextStepDispatcherExperiment extends BusinessExperiment {
  id = 'next-step-dispatcher';
  name = 'Next-step dispatcher';
  category: ExperimentCategory = 'business_outcome';
  hypothesis =
    'next_step events produced by the conversation analyst are only useful if '
    + 'something in the loop converts them into concrete work. Routing each step '
    + 'to a proposal (bug/feature) or a needs_approval task (question/follow_up) '
    + 'closes the conversation → action loop.';
  cadence: ExperimentCadence = {
    everyMs: DEFAULT_INTERVAL_MS,
    runOnBoot: true,
  };

  private readonly maxPerTick: number;
  private readonly approvalsJsonlPath: string | null;

  constructor(opts: BusinessExperimentOptions & {
    maxPerTick?: number;
    /** Path to x-approvals.jsonl. When absent, reply routing falls back
     * to a no-op (step stays 'open') instead of producing dangling
     * approvals that nothing can send. */
    approvalsJsonlPath?: string;
  } = {}) {
    super(opts);
    this.maxPerTick = opts.maxPerTick ?? DEFAULT_MAX_PER_TICK;
    this.approvalsJsonlPath = opts.approvalsJsonlPath ?? null;
  }

  protected async businessProbe(ctx: ExperimentContext): Promise<ProbeResult> {
    // 1. Close the loop on prior ticks: any reply we queued that has
    //    since been sent by XDmReplyDispatcher should flip to 'shipped'
    //    here. Runs first so the Pulse UI reflects shipped state even
    //    on ticks where no new steps are dispatched.
    let reconciled = { scanned: 0, shipped: 0 };
    if (this.approvalsJsonlPath) {
      reconciled = await reconcileShippedNextSteps(
        ctx.db,
        ctx.workspaceId,
        this.approvalsJsonlPath,
      );
    }

    const open = await this.loadOpenSteps(ctx.db, ctx.workspaceId);
    if (open.length === 0) {
      return {
        subject: 'dispatcher',
        summary: reconciled.shipped > 0
          ? `no open next_step events; ${reconciled.shipped} shipped via approval reconciliation`
          : 'no open next_step events',
        evidence: {
          open_total: 0, dispatched: 0, ignored: 0, errors: 0, results: [],
          reconciled_scanned: reconciled.scanned,
          reconciled_shipped: reconciled.shipped,
        },
      };
    }

    const slice = open.slice(0, this.maxPerTick);
    const results: DispatchResult[] = [];
    for (const step of slice) {
      try {
        const result = await this.dispatchOne(ctx, step);
        results.push(result);
      } catch (err) {
        results.push({
          eventId: step.eventId,
          contactName: step.contactName,
          step_type: step.payload.step_type,
          outcome: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const dispatched = results.filter(r => r.outcome === 'dispatched').length;
    const ignored = results.filter(r => r.outcome === 'ignored').length;
    const errors = results.filter(r => r.outcome === 'error').length;

    return {
      subject: 'dispatcher',
      summary:
        `dispatched ${dispatched}, ignored ${ignored}, errors ${errors} of ${slice.length} open step${slice.length === 1 ? '' : 's'}`
        + (reconciled.shipped > 0 ? ` · ${reconciled.shipped} shipped` : ''),
      evidence: {
        open_total: open.length,
        processed: slice.length,
        dispatched,
        ignored,
        errors,
        results,
        reconciled_scanned: reconciled.scanned,
        reconciled_shipped: reconciled.shipped,
      },
    };
  }

  protected businessJudge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as { processed?: number; dispatched?: number; errors?: number };
    const processed = ev.processed ?? 0;
    const errors = ev.errors ?? 0;
    const dispatched = ev.dispatched ?? 0;
    if (processed > 0 && errors * 2 >= processed) return 'fail';
    if (dispatched > 0) return 'warning';
    return 'pass';
  }

  private async loadOpenSteps(db: DatabaseAdapter, workspaceId: string): Promise<OpenNextStep[]> {
    interface Row {
      id: string;
      contact_id: string;
      created_at: string;
      payload: string | null;
    }
    const { data } = await db
      .from<Row>('agent_workforce_contact_events')
      .select('id, contact_id, created_at, payload')
      .eq('workspace_id', workspaceId)
      .eq('kind', 'next_step')
      .order('created_at', { ascending: true })
      .limit(100);
    const rows = (data as Row[] | null) ?? [];
    if (rows.length === 0) return [];

    // Hydrate contact names in one batch.
    const contactIds = Array.from(new Set(rows.map(r => r.contact_id)));
    const nameByContactId = await this.loadContactNames(db, workspaceId, contactIds);

    const out: OpenNextStep[] = [];
    for (const row of rows) {
      const payload = parsePayload(row.payload);
      if (!payload) continue;
      if ((payload.status ?? 'open') !== 'open') continue;
      out.push({
        eventId: row.id,
        contactId: row.contact_id,
        contactName: nameByContactId.get(row.contact_id) ?? 'Unknown contact',
        createdAt: row.created_at,
        payload,
      });
    }
    return out;
  }

  private async loadContactNames(
    db: DatabaseAdapter,
    workspaceId: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (ids.length === 0) return result;
    const { data } = await db
      .from<{ id: string; name: string }>('agent_workforce_contacts')
      .select('id, name')
      .eq('workspace_id', workspaceId)
      .in('id', ids);
    const rows = (data as Array<{ id: string; name: string }> | null) ?? [];
    for (const row of rows) result.set(row.id, row.name);
    return result;
  }

  private async dispatchOne(ctx: ExperimentContext, step: OpenNextStep): Promise<DispatchResult> {
    const type = step.payload.step_type;

    if (type === 'nothing' || type === 'sentiment') {
      await this.setStatus(ctx.db, step.eventId, step.payload, 'ignored');
      return {
        eventId: step.eventId,
        contactName: step.contactName,
        step_type: type,
        outcome: 'ignored',
      };
    }

    if (type === 'bug_report' || type === 'feature_request') {
      const finding = await this.emitProposalFinding(ctx, step);
      await this.setStatus(ctx.db, step.eventId, step.payload, 'dispatched', {
        dispatched_kind: 'proposal',
        finding_id: finding.id,
      });
      return {
        eventId: step.eventId,
        contactName: step.contactName,
        step_type: type,
        outcome: 'dispatched',
        action: `proposal finding ${finding.id.slice(0, 8)}`,
      };
    }

    if (type === 'question' || type === 'follow_up') {
      const queued = await this.queueReplyApproval(ctx, step);
      if (!queued) {
        // Approvals path unavailable (no jsonl configured, missing
        // conversation_pair, etc.) — leave the step open so a future
        // tick with proper wiring can still dispatch. No task
        // fallback: we don't want dangling agent tasks that nothing
        // closes.
        return {
          eventId: step.eventId,
          contactName: step.contactName,
          step_type: type,
          outcome: 'error',
          error: 'reply approval could not be queued',
        };
      }
      await this.setStatus(ctx.db, step.eventId, step.payload, 'dispatched', {
        dispatched_kind: 'reply_approval',
        approval_id: queued.approvalId,
        approval_status: queued.approvalStatus,
        conversation_pair: queued.conversationPair,
      });
      return {
        eventId: step.eventId,
        contactName: step.contactName,
        step_type: type,
        outcome: 'dispatched',
        action: `approval ${queued.approvalId.slice(0, 8)} (${queued.approvalStatus})`,
      };
    }

    // Safety net
    await this.setStatus(ctx.db, step.eventId, step.payload, 'ignored');
    return {
      eventId: step.eventId,
      contactName: step.contactName,
      step_type: type,
      outcome: 'ignored',
    };
  }

  private async emitProposalFinding(
    ctx: ExperimentContext,
    step: OpenNextStep,
  ): Promise<{ id: string }> {
    const slugBase = slugify(step.payload.text).slice(0, 48);
    const slug = `contact-${step.payload.step_type}-${slugBase}-${Date.now().toString(36)}`;
    const findingId = await writeFinding(ctx.db, {
      experimentId: this.id,
      category: 'experiment_proposal',
      subject: `proposal:${slug}`,
      hypothesis:
        `User-reported ${step.payload.step_type.replace('_', ' ')} via DM with `
        + `${step.contactName}: ${step.payload.text}`,
      verdict: 'warning',
      summary: step.payload.suggested_action || step.payload.text,
      evidence: {
        brief: {
          slug,
          name: titleCase(step.payload.step_type) + ': ' + step.payload.text.slice(0, 80),
          hypothesis: step.payload.text,
          everyMs: 60 * 60 * 1000,
          template: step.payload.step_type === 'bug_report' ? 'investigation_probe' : 'feature_probe',
          params: {
            probe_description: step.payload.suggested_action,
            category: 'other',
            source: 'contact_conversation',
            contact_id: step.contactId,
            contact_name: step.contactName,
            urgency: step.payload.urgency,
          },
        },
        source: 'next_step_dispatcher',
        origin_event_id: step.eventId,
        contact_id: step.contactId,
        contact_name: step.contactName,
        step_type: step.payload.step_type,
        urgency: step.payload.urgency,
        text: step.payload.text,
        suggested_action: step.payload.suggested_action,
      },
      interventionApplied: null,
      ranAt: new Date().toISOString(),
      durationMs: 0,
    });
    return { id: findingId };
  }

  /**
   * Route a question / follow_up next_step to the X DM send queue.
   * Returns null when the step can't be queued (no approvalsJsonlPath
   * wired, or the contact has no DM conversation_pair) — the caller
   * treats null as 'error, leave open'.
   */
  private async queueReplyApproval(
    ctx: ExperimentContext,
    step: OpenNextStep,
  ): Promise<{ approvalId: string; approvalStatus: string; conversationPair: string } | null> {
    if (!this.approvalsJsonlPath) return null;

    const conversationPair = await this.lookupConversationPair(ctx.db, ctx.workspaceId, step.contactId);
    if (!conversationPair) {
      logger.debug(
        { contactId: step.contactId },
        '[next-step-dispatcher] no conversation_pair on contact; cannot queue DM reply',
      );
      return null;
    }

    const typePrefix = step.payload.step_type === 'question' ? 'Reply' : 'Follow-up';
    const replyText = step.payload.suggested_action?.trim() || step.payload.text.trim();
    if (!replyText) return null;
    const summary = `${typePrefix} to ${step.contactName ?? 'contact'}: ${step.payload.text.slice(0, 80)}`;

    try {
      const approval = proposeReplyFromNextStep({
        approvalsJsonlPath: this.approvalsJsonlPath,
        workspace: ctx.workspaceSlug ?? 'default',
        contactId: step.contactId,
        contactName: step.contactName,
        conversationPair,
        replyText,
        summary,
        nextStepEventId: step.eventId,
        stepType: step.payload.step_type,
        urgency: step.payload.urgency,
      });
      return {
        approvalId: approval.id,
        approvalStatus: approval.status,
        conversationPair,
      };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, contactId: step.contactId },
        '[next-step-dispatcher] proposeReplyFromNextStep failed',
      );
      return null;
    }
  }

  /**
   * Pull the X DM conversation_pair for a contact. Analyst-source
   * contacts store it in custom_fields.x_conversation_pair; other
   * contacts won't have one and we return null.
   */
  private async lookupConversationPair(
    db: DatabaseAdapter,
    workspaceId: string,
    contactId: string,
  ): Promise<string | null> {
    try {
      const { data } = await db
        .from<{ custom_fields: unknown }>('agent_workforce_contacts')
        .select('custom_fields')
        .eq('workspace_id', workspaceId)
        .eq('id', contactId)
        .maybeSingle();
      if (!data) return null;
      const customFields = (data as { custom_fields: unknown }).custom_fields;
      let obj: Record<string, unknown> | null = null;
      if (typeof customFields === 'object' && customFields !== null) {
        obj = customFields as Record<string, unknown>;
      } else if (typeof customFields === 'string') {
        try { obj = JSON.parse(customFields) as Record<string, unknown>; } catch { obj = null; }
      }
      if (!obj) return null;
      const pair = obj.x_conversation_pair;
      return typeof pair === 'string' && pair.length > 0 ? pair : null;
    } catch {
      return null;
    }
  }

  private async setStatus(
    db: DatabaseAdapter,
    eventId: string,
    payload: NextStepPayload,
    newStatus: NextStepStatus,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const merged: Record<string, unknown> = {
      ...payload,
      ...extra,
      status: newStatus,
      dispatched_at: new Date().toISOString(),
    };
    try {
      await db
        .from('agent_workforce_contact_events')
        .update({ payload: JSON.stringify(merged) })
        .eq('id', eventId);
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : err, eventId, newStatus },
        '[next-step-dispatcher] status update failed',
      );
    }
  }
}

function parsePayload(raw: unknown): NextStepPayload | null {
  if (!raw) return null;
  // Adapter may hand us either the raw JSON string or an already-parsed
  // object. Normalize both.
  let obj: Partial<NextStepPayload> | null = null;
  if (typeof raw === 'object') {
    obj = raw as Partial<NextStepPayload>;
  } else if (typeof raw === 'string') {
    try { obj = JSON.parse(raw) as Partial<NextStepPayload>; } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  if (!obj.step_type || !obj.text || !obj.urgency) return null;
  return {
    step_type: obj.step_type,
    urgency: obj.urgency,
    text: obj.text,
    suggested_action: obj.suggested_action ?? '',
    status: obj.status ?? 'open',
    source_message_ids: obj.source_message_ids,
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function titleCase(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}
