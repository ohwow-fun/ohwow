/**
 * EmailDispatcher — drains operator-approved email_outbound entries
 * from the shared x-approvals.jsonl and hands them to the configured
 * provider (today: Resend). Mirrors XDmReplyDispatcher in shape so
 * there's one mental model for "approval → send":
 *
 *   1. Read pending email_outbound approvals (approved / auto_applied).
 *   2. For each (oldest first):
 *      a. Re-check cross-channel cooldown via outreach-policy.
 *      b. Resolve the contact's email + outreach_token.
 *      c. Attach ?t=<token> to any CTA URL referenced in the approval.
 *      d. Call the provider with an idempotency key = approval.id.
 *      e. On success: insert an email:sent contact_event and mark the
 *         approval 'applied' with the provider id.
 *      f. On failure: leave the approval for retry (short-lived errors)
 *         or mark applied-with-failure (permanent shape errors like
 *         missing_to).
 *
 * Cadence: 5 minutes. Email is the slowest outbound channel because
 * delivery reports + replies take longer to get back — a 2-minute
 * cadence like the DM dispatcher would just starve the CDP lane for
 * a cheaper task.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';
import { isContactInCooldown } from '../lib/outreach-policy.js';
import {
  attachOutreachTokenToUrl,
  type EmailSender,
  type SendEmailInput,
} from '../integrations/email/resend.js';
import {
  listApprovalsForKind,
  markApprovalApplied,
  type ApprovalEntry,
} from './approval-queue.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SENDS_PER_TICK = 5;
const APPROVAL_KIND = 'email_outbound';
/** Statuses that indicate a permanent shape failure — mark applied, don't retry. */
const PERMANENT_FAILURE_REASONS = new Set<string>([
  'missing_to',
  'missing_subject',
  'missing_body',
  'no_contact',
  'contact_missing_email',
]);

interface ContactRow {
  id: string;
  email: string | null;
  name: string | null;
  outreach_token: string | null;
}

export interface EmailDispatcherOptions {
  approvalsJsonlPath: string;
  dataDir?: string;
  sender: EmailSender;
}

export class EmailDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private executing = false;
  private readonly approvalsJsonlPath: string;
  private readonly dataDir: string | null;
  private readonly sender: EmailSender;

  constructor(
    private db: DatabaseAdapter,
    private workspaceId: string,
    options: EmailDispatcherOptions,
  ) {
    this.approvalsJsonlPath = options.approvalsJsonlPath;
    this.dataDir = options.dataDir ?? null;
    this.sender = options.sender;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    logger.info({ intervalMs }, '[EmailDispatcher] started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.running = false;
    logger.info('[EmailDispatcher] stopped');
  }

  async tick(): Promise<void> {
    if (this.executing) return;
    this.executing = true;
    const started = Date.now();
    try {
      const approvals = listApprovalsForKind(this.approvalsJsonlPath, APPROVAL_KIND);
      if (approvals.length === 0) return;
      const batch = approvals.slice(0, MAX_SENDS_PER_TICK);
      let sent = 0;
      let failed = 0;
      for (const approval of batch) {
        const ok = await this.dispatchOne(approval);
        if (ok) sent++;
        else failed++;
      }
      logger.info(
        {
          approvalsTotal: approvals.length,
          attempted: batch.length,
          sent,
          failed,
          ms: Date.now() - started,
        },
        '[EmailDispatcher] tick complete',
      );
    } catch (err) {
      logger.error({ err }, '[EmailDispatcher] tick failed');
    } finally {
      this.executing = false;
    }
  }

  private async dispatchOne(approval: ApprovalEntry): Promise<boolean> {
    const payload = approval.payload ?? {};
    const contactId = typeof payload.contact_id === 'string' ? payload.contact_id : null;
    const subject = typeof payload.subject === 'string' ? payload.subject.trim() : '';
    const text = typeof payload.text === 'string' ? payload.text : '';
    const html = typeof payload.html === 'string' ? payload.html : '';
    const replyTo = typeof payload.reply_to === 'string' ? payload.reply_to : undefined;
    const ctaUrl = typeof payload.cta_url === 'string' ? payload.cta_url : null;

    if (!contactId) {
      this.markTerminal(approval, 'no_contact');
      return false;
    }
    if (!subject || (!text && !html)) {
      this.markTerminal(approval, !subject ? 'missing_subject' : 'missing_body');
      return false;
    }

    let contact: ContactRow | null = null;
    try {
      const { data } = await this.db
        .from<ContactRow>('agent_workforce_contacts')
        .select('id, email, name, outreach_token')
        .eq('id', contactId)
        .eq('workspace_id', this.workspaceId)
        .maybeSingle();
      contact = (data as ContactRow | null) ?? null;
    } catch (err) {
      logger.warn({ err, approvalId: approval.id }, '[EmailDispatcher] contact lookup failed');
    }

    if (!contact || !contact.email) {
      this.markTerminal(approval, !contact ? 'no_contact' : 'contact_missing_email');
      return false;
    }

    const cooldown = await isContactInCooldown(this.db, this.workspaceId, contact.id, 'email');
    if (cooldown.inCooldown) {
      logger.info(
        {
          approvalId: approval.id,
          contactId: contact.id,
          lastEventKind: cooldown.lastEventKind,
          lastEventAt: cooldown.lastEventAt,
          windowHours: cooldown.windowHours,
        },
        '[EmailDispatcher] contact in cooldown; marking applied without sending',
      );
      markApprovalApplied(this.approvalsJsonlPath, approval.id, {
        posted: false,
        by: 'email_dispatcher',
        reason: 'cross_channel_cooldown',
        last_event_kind: cooldown.lastEventKind,
        last_event_at: cooldown.lastEventAt,
      });
      return false;
    }

    // Attribution token embedding. If the approval's CTA URL is set,
    // append ?t=<token> so the recipient's click fires the attribution
    // endpoint. If the body text/html contains the raw CTA URL, swap
    // occurrences for the tokenized variant.
    const tokenizedCta = ctaUrl && contact.outreach_token
      ? attachOutreachTokenToUrl(ctaUrl, contact.outreach_token)
      : ctaUrl;
    const rendered: SendEmailInput = {
      to: contact.email,
      subject,
      replyTo,
      idempotencyKey: approval.id,
      tags: [{ name: 'workspace', value: this.workspaceId }],
    };
    if (text) rendered.text = ctaUrl && tokenizedCta ? text.replaceAll(ctaUrl, tokenizedCta) : text;
    if (html) rendered.html = ctaUrl && tokenizedCta ? html.replaceAll(ctaUrl, tokenizedCta) : html;

    const result = await this.sender(rendered);

    if (!result.ok) {
      if (result.reason && PERMANENT_FAILURE_REASONS.has(result.reason)) {
        this.markTerminal(approval, result.reason);
        return false;
      }
      if (result.reason === 'no_api_key') {
        logger.warn({ approvalId: approval.id }, '[EmailDispatcher] no API key configured; leaving approval for retry');
        return false;
      }
      logger.warn(
        { approvalId: approval.id, reason: result.reason, status: result.status },
        '[EmailDispatcher] send failed; leaving approval for retry',
      );
      return false;
    }

    const nowIso = new Date().toISOString();
    const eventPayload = {
      provider: 'resend',
      provider_id: result.providerId,
      to: contact.email,
      subject,
      cta_url: tokenizedCta,
      approval_id: approval.id,
    };
    const eventPayloadJson = JSON.stringify(eventPayload);
    try {
      await this.db.from('agent_workforce_contact_events').insert({
        id: crypto.randomUUID(),
        workspace_id: this.workspaceId,
        contact_id: contact.id,
        kind: 'email:sent',
        source: 'email-dispatcher',
        payload: eventPayloadJson,
        occurred_at: nowIso,
        event_type: 'email:sent',
        title: `email:sent (${subject.slice(0, 40)})`,
        metadata: eventPayloadJson,
        created_at: nowIso,
      });
    } catch (err) {
      logger.warn({ err, approvalId: approval.id }, '[EmailDispatcher] event insert failed (send succeeded)');
    }

    this.appendJsonl({
      kind: 'email_sent',
      ts: nowIso,
      contact_id: contact.id,
      provider_id: result.providerId,
      subject,
      approval_id: approval.id,
    });
    markApprovalApplied(this.approvalsJsonlPath, approval.id, {
      posted: true,
      by: 'email_dispatcher',
      provider: 'resend',
      provider_id: result.providerId,
      contact_id: contact.id,
    });
    logger.info({ approvalId: approval.id, providerId: result.providerId, to: contact.email }, '[EmailDispatcher] sent email');
    return true;
  }

  private markTerminal(approval: ApprovalEntry, reason: string): void {
    logger.warn({ approvalId: approval.id, reason }, '[EmailDispatcher] permanent failure; marking applied');
    markApprovalApplied(this.approvalsJsonlPath, approval.id, {
      posted: false,
      by: 'email_dispatcher',
      reason,
    });
  }

  private appendJsonl(entry: Record<string, unknown>): void {
    if (!this.dataDir) return;
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(this.dataDir, `emails-${day}.jsonl`);
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      logger.warn({ err, file }, '[EmailDispatcher] JSONL append failed');
    }
  }
}
