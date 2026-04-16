/**
 * Stripe Webhook Handler
 *
 * Funnel Surgeon Phase 1: the only path by which real dollars land in
 * agent_workforce_revenue_entries with an attributed contact_id.
 * Stripe POSTs to `/webhooks/stripe` with an HMAC signature in the
 * `Stripe-Signature` header over `${timestamp}.${rawBody}`. This
 * handler:
 *
 *   1. Verifies the signature with the workspace's stripe_webhook_secret.
 *   2. Persists the raw event to webhook_events for audit. The event id
 *      is Stripe's `evt_xxx` so duplicate deliveries land a UNIQUE
 *      violation and the second send is acknowledged without being
 *      re-processed — Stripe's at-least-once delivery becomes
 *      effectively exactly-once.
 *   3. Looks the contact up by `custom_fields.stripe_customer_id`.
 *   4. If found, appends a `kind='plan:paid'` contact_event and inserts
 *      a matching revenue_entries row with contact_id + source_event_id.
 *   5. 200s immediately; heavy work happens after the response is sent.
 *
 * Kill switch: no webhook secret = no processing. A 503 returned to
 * Stripe triggers their retry, which is acceptable while the secret
 * is being configured.
 *
 * Only `invoice.paid` and `customer.subscription.created` are handled.
 * Other event types are audited to webhook_events but produce no
 * downstream contact_event or revenue_entries row.
 */

import { Router } from 'express';
import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

export const STRIPE_HANDLED_EVENTS = new Set<string>([
  'invoice.paid',
  'customer.subscription.created',
]);

export interface StripeWebhookDeps {
  db: DatabaseAdapter;
  /** The workspace this daemon is bound to; stripe webhooks are workspace-scoped. */
  workspaceId: string;
  /** Returns the workspace's stripe webhook secret (runtime_settings). */
  getStripeWebhookSecret: () => Promise<string | undefined>;
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: unknown };
}

interface StripeInvoice {
  id?: string;
  customer?: string;
  amount_paid?: number;
  currency?: string;
  lines?: {
    data?: Array<{
      price?: { nickname?: string | null; id?: string };
      period?: { start?: number; end?: number };
    }>;
  };
}

interface StripeSubscription {
  id?: string;
  customer?: string;
  current_period_start?: number;
  current_period_end?: number;
  items?: {
    data?: Array<{
      price?: { nickname?: string | null; unit_amount?: number; currency?: string };
      quantity?: number;
    }>;
  };
}

/**
 * Constant-time verify of a Stripe signature header against a raw
 * body. Header format: `t=<unix>,v1=<hex>,v1=<hex-rotating>`. Only
 * v1 schemes are accepted; v0 is Stripe's legacy pre-release format
 * and we deliberately do not support it.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined | null,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  let ts: string | null = null;
  const sigs: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (!k || !v) continue;
    if (k === 't') ts = v;
    else if (k === 'v1') sigs.push(v);
  }
  if (!ts || sigs.length === 0) return false;
  const signedPayload = `${ts}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const expectedBuf = Buffer.from(expected);
  return sigs.some((sig) => {
    const sigBuf = Buffer.from(sig);
    if (sigBuf.length !== expectedBuf.length) return false;
    try {
      return crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  });
}

function extractRevenueFromInvoice(obj: StripeInvoice): {
  amountCents: number;
  plan: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  stripeCustomerId: string | null;
} {
  const firstLine = obj.lines?.data?.[0];
  const periodStart = firstLine?.period?.start ? new Date(firstLine.period.start * 1000).toISOString() : null;
  const periodEnd = firstLine?.period?.end ? new Date(firstLine.period.end * 1000).toISOString() : null;
  return {
    amountCents: Number(obj.amount_paid ?? 0),
    plan: firstLine?.price?.nickname ?? firstLine?.price?.id ?? null,
    periodStart,
    periodEnd,
    stripeCustomerId: obj.customer ?? null,
  };
}

function extractRevenueFromSubscription(obj: StripeSubscription): {
  amountCents: number;
  plan: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  stripeCustomerId: string | null;
} {
  const items = obj.items?.data ?? [];
  let amountCents = 0;
  for (const item of items) {
    const unit = Number(item.price?.unit_amount ?? 0);
    const qty = Number(item.quantity ?? 1);
    amountCents += unit * qty;
  }
  const firstItem = items[0];
  const periodStart = obj.current_period_start ? new Date(obj.current_period_start * 1000).toISOString() : null;
  const periodEnd = obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null;
  return {
    amountCents,
    plan: firstItem?.price?.nickname ?? null,
    periodStart,
    periodEnd,
    stripeCustomerId: obj.customer ?? null,
  };
}

interface ContactRow {
  id: string;
  workspace_id: string;
}

async function findContactByStripeCustomerId(
  db: DatabaseAdapter,
  workspaceId: string,
  stripeCustomerId: string,
): Promise<ContactRow | null> {
  const { data } = await db
    .from<ContactRow>('agent_workforce_contacts')
    .select('id, workspace_id')
    .eq('workspace_id', workspaceId)
    .eq(`json_extract(custom_fields, '$.stripe_customer_id')`, stripeCustomerId)
    .limit(1);
  const rows = (data ?? []) as ContactRow[];
  return rows[0] ?? null;
}

/**
 * Exported for tests — creates the contact_event + revenue_entries
 * rows for a verified, deduped Stripe event. Callers are responsible
 * for signature verification and idempotency gates.
 */
export async function processStripeEvent(
  deps: StripeWebhookDeps,
  event: StripeEvent,
): Promise<{ processed: boolean; reason?: string }> {
  if (!STRIPE_HANDLED_EVENTS.has(event.type)) {
    return { processed: false, reason: `unhandled type ${event.type}` };
  }

  const obj = event.data?.object as StripeInvoice | StripeSubscription | undefined;
  if (!obj || typeof obj !== 'object') {
    return { processed: false, reason: 'missing data.object' };
  }

  const extracted = event.type === 'invoice.paid'
    ? extractRevenueFromInvoice(obj as StripeInvoice)
    : extractRevenueFromSubscription(obj as StripeSubscription);

  if (!extracted.stripeCustomerId) {
    return { processed: false, reason: 'missing customer id' };
  }

  const contact = await findContactByStripeCustomerId(
    deps.db,
    deps.workspaceId,
    extracted.stripeCustomerId,
  );
  if (!contact) {
    logger.info(
      { eventId: event.id, type: event.type, stripeCustomerId: extracted.stripeCustomerId },
      '[stripe-webhook] no matching contact — audited only',
    );
    return { processed: false, reason: 'contact not found' };
  }

  const eventRowId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const payload = {
    amount_cents: extracted.amountCents,
    plan: extracted.plan,
    period_start: extracted.periodStart,
    period_end: extracted.periodEnd,
    stripe_event_id: event.id,
    stripe_event_type: event.type,
  };
  const payloadJson = JSON.stringify(payload);

  await deps.db.from('agent_workforce_contact_events').insert({
    id: eventRowId,
    workspace_id: deps.workspaceId,
    contact_id: contact.id,
    kind: 'plan:paid',
    source: 'stripe',
    payload: payloadJson,
    occurred_at: nowIso,
    event_type: 'plan:paid',
    title: `Stripe ${event.type}`,
    metadata: payloadJson,
    created_at: nowIso,
  });

  if (extracted.amountCents > 0) {
    const monthIdx = new Date(nowIso).getUTCMonth() + 1;
    const year = new Date(nowIso).getUTCFullYear();
    await deps.db.from('agent_workforce_revenue_entries').insert({
      id: crypto.randomUUID(),
      workspace_id: deps.workspaceId,
      contact_id: contact.id,
      source_event_id: eventRowId,
      amount_cents: extracted.amountCents,
      month: monthIdx,
      year,
      source: 'stripe',
      created_at: nowIso,
    });
  }

  return { processed: true };
}

export function createStripeWebhookRouter(deps: StripeWebhookDeps): Router {
  const router = Router();

  router.post('/webhooks/stripe', async (req, res) => {
    const rawBody = req.rawBody;
    const signatureHeader = (req.headers['stripe-signature'] ?? null) as string | string[] | null;
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

    let secret: string | undefined;
    try {
      secret = await deps.getStripeWebhookSecret();
    } catch (err) {
      logger.warn({ err }, '[stripe-webhook] secret lookup failed');
    }

    if (!secret) {
      // 503 → Stripe retries. The operator sets the secret, retries succeed.
      res.status(503).json({ error: 'stripe webhook secret not configured' });
      return;
    }
    if (!rawBody) {
      res.status(400).json({ error: 'raw body unavailable' });
      return;
    }
    if (!verifyStripeSignature(rawBody, signature, secret)) {
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    let event: StripeEvent;
    try {
      const parsed = JSON.parse(rawBody.toString('utf8')) as StripeEvent;
      if (!parsed.id || !parsed.type) {
        res.status(400).json({ error: 'missing id/type' });
        return;
      }
      event = parsed;
    } catch {
      res.status(400).json({ error: 'invalid json' });
      return;
    }

    // Idempotency: use stripe event.id as the webhook_events primary
    // key. A duplicate delivery triggers a UNIQUE violation which we
    // treat as "already seen, acknowledge and skip downstream work".
    // The adapter surfaces constraint errors via the returned {error}
    // envelope rather than throwing, so we branch on both paths.
    let alreadySeen = false;
    try {
      const { error } = await deps.db.from('webhook_events').insert({
        id: event.id,
        source: 'stripe',
        event_type: event.type,
        payload: JSON.stringify(event),
        headers: JSON.stringify({ 'stripe-signature': signature }),
        processed: 0,
      });
      if (error) {
        const msg = (error as { message?: string }).message ?? String(error);
        if (/UNIQUE|constraint/i.test(msg)) {
          alreadySeen = true;
        } else {
          logger.warn({ err: error, eventId: event.id }, '[stripe-webhook] audit insert error');
          res.status(500).json({ error: 'persist failed' });
          return;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE|constraint/i.test(msg)) {
        alreadySeen = true;
      } else {
        logger.warn({ err, eventId: event.id }, '[stripe-webhook] audit insert threw');
        res.status(500).json({ error: 'persist failed' });
        return;
      }
    }

    res.status(200).json({ received: true, duplicate: alreadySeen });

    if (alreadySeen) return;

    void processStripeEvent(deps, event)
      .then(async (result) => {
        if (result.processed) {
          try {
            await deps.db.from('webhook_events').update({ processed: 1 }).eq('id', event.id);
          } catch (err) {
            logger.debug({ err, eventId: event.id }, '[stripe-webhook] mark processed failed');
          }
        } else {
          logger.debug({ eventId: event.id, reason: result.reason }, '[stripe-webhook] event not processed');
        }
      })
      .catch((err) => {
        logger.error({ err, eventId: event.id, type: event.type }, '[stripe-webhook] processing threw');
      });
  });

  return router;
}
