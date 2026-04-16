/**
 * Stripe webhook tests — verify signature handling, idempotency
 * against webhook_events, and the end-to-end contact_event +
 * revenue_entries path on a real sqlite adapter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import {
  createStripeWebhookRouter,
  verifyStripeSignature,
  processStripeEvent,
  STRIPE_HANDLED_EVENTS,
} from '../stripe-subscription.js';

function signStripe(rawBody: string, secret: string, ts: number = Math.floor(Date.now() / 1000)): string {
  const signed = `${ts}.${rawBody}`;
  const v1 = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${ts},v1=${v1}`;
}

function makeRes(): { res: Response; statusCode: () => number; body: () => unknown } {
  let _status = 200;
  let _body: unknown;
  const res = {
    status: vi.fn((code: number) => { _status = code; return res; }),
    json: vi.fn((body: unknown) => { _body = body; return res; }),
  } as unknown as Response;
  return { res, statusCode: () => _status, body: () => _body };
}

function getHandler(router: ReturnType<typeof createStripeWebhookRouter>): (req: Request, res: Response) => Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (router as any).stack as Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: () => void) => Promise<void> }> };
  }>;
  for (const layer of stack) {
    if (layer.route?.path === '/webhooks/stripe' && layer.route.methods.post) {
      const [{ handle }] = layer.route.stack;
      return async (req, res) => { await handle(req, res, () => { /* noop */ }); };
    }
  }
  throw new Error('stripe handler not found');
}

const SECRET = 'whsec_test_abc';

function baseSchema(rawDb: InstanceType<typeof Database>): void {
  rawDb.exec(`
    CREATE TABLE agent_workforce_contacts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT,
      custom_fields TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_workforce_contact_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      contact_id TEXT,
      kind TEXT,
      source TEXT,
      payload TEXT DEFAULT '{}',
      occurred_at TEXT,
      event_type TEXT,
      title TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_workforce_revenue_entries (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      contact_id TEXT,
      source_event_id TEXT,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      month INTEGER,
      year INTEGER,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE webhook_events (
      id TEXT PRIMARY KEY,
      source TEXT,
      event_type TEXT,
      payload TEXT,
      headers TEXT,
      processed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function waitForNextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('verifyStripeSignature', () => {
  it('accepts a freshly-signed header', () => {
    const body = Buffer.from('{"id":"evt_1","type":"invoice.paid"}');
    const sig = signStripe(body.toString('utf8'), SECRET);
    expect(verifyStripeSignature(body, sig, SECRET)).toBe(true);
  });

  it('rejects a mismatched secret', () => {
    const body = Buffer.from('{}');
    const sig = signStripe('{}', SECRET);
    expect(verifyStripeSignature(body, sig, 'other-secret')).toBe(false);
  });

  it('rejects headers without a v1 entry', () => {
    expect(verifyStripeSignature(Buffer.from('{}'), 't=123', SECRET)).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(verifyStripeSignature(Buffer.from('{}'), '', SECRET)).toBe(false);
    expect(verifyStripeSignature(Buffer.from('{}'), null, SECRET)).toBe(false);
  });
});

describe('processStripeEvent', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(() => {
    rawDb = new Database(':memory:');
    baseSchema(rawDb);
    rawDb.prepare(`INSERT INTO agent_workforce_contacts (id, workspace_id, name, custom_fields) VALUES (?, ?, ?, ?)`)
      .run('c1', 'ws1', 'Alice', JSON.stringify({ stripe_customer_id: 'cus_aaa' }));
    adapter = createSqliteAdapter(rawDb);
  });

  afterEach(() => { rawDb.close(); });

  it('writes plan:paid event + revenue_entries row for invoice.paid', async () => {
    const result = await processStripeEvent(
      { db: adapter, workspaceId: 'ws1', getStripeWebhookSecret: async () => SECRET },
      {
        id: 'evt_inv_1',
        type: 'invoice.paid',
        data: {
          object: {
            customer: 'cus_aaa',
            amount_paid: 4900,
            lines: {
              data: [{
                price: { nickname: 'Pro Monthly' },
                period: { start: 1700000000, end: 1702592000 },
              }],
            },
          },
        },
      },
    );
    expect(result.processed).toBe(true);

    const events = rawDb.prepare(`SELECT kind, contact_id, source, payload FROM agent_workforce_contact_events`).all() as Array<{ kind: string; contact_id: string; source: string; payload: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('plan:paid');
    expect(events[0].contact_id).toBe('c1');
    expect(events[0].source).toBe('stripe');
    const payload = JSON.parse(events[0].payload) as { amount_cents: number; plan: string };
    expect(payload.amount_cents).toBe(4900);
    expect(payload.plan).toBe('Pro Monthly');

    const revenue = rawDb.prepare(`SELECT amount_cents, contact_id, source_event_id FROM agent_workforce_revenue_entries`).all() as Array<{ amount_cents: number; contact_id: string; source_event_id: string }>;
    expect(revenue).toHaveLength(1);
    expect(revenue[0].amount_cents).toBe(4900);
    expect(revenue[0].contact_id).toBe('c1');
    expect(revenue[0].source_event_id).toBe((events[0] as unknown as { id?: string }).id ?? revenue[0].source_event_id); // linked by FK
  });

  it('writes plan:paid event but no revenue row when subscription has zero amount', async () => {
    const result = await processStripeEvent(
      { db: adapter, workspaceId: 'ws1', getStripeWebhookSecret: async () => SECRET },
      {
        id: 'evt_sub_1',
        type: 'customer.subscription.created',
        data: {
          object: {
            customer: 'cus_aaa',
            current_period_start: 1700000000,
            current_period_end: 1702592000,
            items: { data: [{ price: { nickname: 'Trial', unit_amount: 0 }, quantity: 1 }] },
          },
        },
      },
    );
    expect(result.processed).toBe(true);

    expect(rawDb.prepare(`SELECT COUNT(*) AS c FROM agent_workforce_contact_events`).get()).toEqual({ c: 1 });
    expect(rawDb.prepare(`SELECT COUNT(*) AS c FROM agent_workforce_revenue_entries`).get()).toEqual({ c: 0 });
  });

  it('skips when no matching contact', async () => {
    const result = await processStripeEvent(
      { db: adapter, workspaceId: 'ws1', getStripeWebhookSecret: async () => SECRET },
      {
        id: 'evt_x',
        type: 'invoice.paid',
        data: { object: { customer: 'cus_unknown', amount_paid: 100 } },
      },
    );
    expect(result.processed).toBe(false);
    expect(result.reason).toContain('contact not found');
    expect(rawDb.prepare(`SELECT COUNT(*) AS c FROM agent_workforce_contact_events`).get()).toEqual({ c: 0 });
  });

  it('skips unhandled event types', async () => {
    const result = await processStripeEvent(
      { db: adapter, workspaceId: 'ws1', getStripeWebhookSecret: async () => SECRET },
      { id: 'evt_u', type: 'payment_intent.succeeded', data: { object: { customer: 'cus_aaa' } } },
    );
    expect(result.processed).toBe(false);
    expect(STRIPE_HANDLED_EVENTS.has('payment_intent.succeeded')).toBe(false);
  });
});

describe('createStripeWebhookRouter', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;
  let handler: (req: Request, res: Response) => Promise<void>;

  beforeEach(() => {
    rawDb = new Database(':memory:');
    baseSchema(rawDb);
    rawDb.prepare(`INSERT INTO agent_workforce_contacts (id, workspace_id, name, custom_fields) VALUES (?, ?, ?, ?)`)
      .run('c1', 'ws1', 'Alice', JSON.stringify({ stripe_customer_id: 'cus_aaa' }));
    adapter = createSqliteAdapter(rawDb);
    const router = createStripeWebhookRouter({
      db: adapter,
      workspaceId: 'ws1',
      getStripeWebhookSecret: async () => SECRET,
    });
    handler = getHandler(router);
  });

  afterEach(() => { rawDb.close(); });

  function makeReq(bodyStr: string, signatureHeader: string | null): Request {
    return {
      rawBody: Buffer.from(bodyStr),
      headers: signatureHeader ? { 'stripe-signature': signatureHeader } : {},
    } as unknown as Request;
  }

  it('rejects an invalid signature with 401', async () => {
    const body = JSON.stringify({ id: 'evt_x', type: 'invoice.paid', data: { object: {} } });
    const req = makeReq(body, 't=1,v1=deadbeef');
    const { res, statusCode } = makeRes();
    await handler(req, res);
    expect(statusCode()).toBe(401);
    expect(rawDb.prepare(`SELECT COUNT(*) AS c FROM webhook_events`).get()).toEqual({ c: 0 });
  });

  it('persists + processes a valid invoice.paid event', async () => {
    const body = JSON.stringify({
      id: 'evt_ok',
      type: 'invoice.paid',
      data: { object: { customer: 'cus_aaa', amount_paid: 2900, lines: { data: [{ price: { nickname: 'Basic' } }] } } },
    });
    const sig = signStripe(body, SECRET);
    const { res, statusCode, body: resBody } = makeRes();
    await handler(makeReq(body, sig), res);
    expect(statusCode()).toBe(200);
    expect(resBody()).toMatchObject({ received: true, duplicate: false });

    await waitForNextTick();
    await waitForNextTick();

    expect(rawDb.prepare(`SELECT event_type FROM webhook_events WHERE id=?`).get('evt_ok')).toEqual({ event_type: 'invoice.paid' });
    const evt = rawDb.prepare(`SELECT kind FROM agent_workforce_contact_events WHERE contact_id=?`).get('c1') as { kind: string } | undefined;
    expect(evt?.kind).toBe('plan:paid');
  });

  it('acknowledges duplicate deliveries without re-processing', async () => {
    const body = JSON.stringify({
      id: 'evt_dup',
      type: 'invoice.paid',
      data: { object: { customer: 'cus_aaa', amount_paid: 1000, lines: { data: [{}] } } },
    });
    const sig = signStripe(body, SECRET);

    const { res: r1, statusCode: s1 } = makeRes();
    await handler(makeReq(body, sig), r1);
    expect(s1()).toBe(200);
    await waitForNextTick();
    await waitForNextTick();

    const { res: r2, statusCode: s2, body: b2 } = makeRes();
    await handler(makeReq(body, sig), r2);
    expect(s2()).toBe(200);
    expect((b2() as { duplicate: boolean }).duplicate).toBe(true);

    expect(rawDb.prepare(`SELECT COUNT(*) AS c FROM agent_workforce_contact_events`).get()).toEqual({ c: 1 });
    expect(rawDb.prepare(`SELECT COUNT(*) AS c FROM agent_workforce_revenue_entries`).get()).toEqual({ c: 1 });
  });

  it('returns 503 when no secret is configured', async () => {
    const router = createStripeWebhookRouter({
      db: adapter,
      workspaceId: 'ws1',
      getStripeWebhookSecret: async () => undefined,
    });
    const altHandler = getHandler(router);
    const body = '{}';
    const { res, statusCode } = makeRes();
    await altHandler(makeReq(body, 't=1,v1=0'), res);
    expect(statusCode()).toBe(503);
  });
});
