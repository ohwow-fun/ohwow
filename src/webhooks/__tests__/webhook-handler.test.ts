import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { createWebhookRouter } from '../webhook-handler.js';
import type { WebhookHandlerDeps } from '../webhook-handler.js';
import type { Request, Response } from 'express';

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../triggers/local-trigger-service.js', () => ({
  LocalTriggerService: vi.fn().mockImplementation(() => ({
    getByWebhookToken: vi.fn().mockResolvedValue(null),
    updateSampleData: vi.fn(),
  })),
}));

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function makeDeps(overrides: Partial<WebhookHandlerDeps> = {}): WebhookHandlerDeps {
  const insertMock = vi.fn().mockReturnValue({
    then: vi.fn().mockImplementation((r: (v: unknown) => void) => r({ data: null, error: null })),
  });
  return {
    db: {
      from: vi.fn().mockReturnValue({
        insert: insertMock,
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            then: vi.fn().mockImplementation((r: (v: unknown) => void) => r({ data: [], error: null })),
          }),
        }),
      }),
    } as never,
    triggerEvaluator: {
      evaluate: vi.fn().mockResolvedValue(undefined),
      evaluateCustom: vi.fn().mockResolvedValue(undefined),
    } as never,
    eventBus: {
      emit: vi.fn(),
    } as never,
    getWebhookSecret: vi.fn().mockResolvedValue('webhook-secret'),
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRouteHandler(router: any, routePath: string): (req: Request, res: Response) => Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = router.stack.find((l: any) => l.route?.path === routePath && l.route?.methods?.post);
  if (!layer) throw new Error(`Route ${routePath} not found`);
  return layer.route.stack[0].handle;
}

function mockRes(): { res: Response; statusCode: () => number; body: () => unknown } {
  let code = 0;
  let responseBody: unknown;
  const res = {
    status: (c: number) => {
      code = c;
      return { json: (b: unknown) => { responseBody = b; } };
    },
  } as Response;
  return { res, statusCode: () => code, body: () => responseBody };
}

describe('createWebhookRouter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a router with webhook routes', () => {
    const deps = makeDeps();
    const router = createWebhookRouter(deps);
    expect(router).toBeDefined();
  });

  it('GHL route rejects bad signatures', async () => {
    const deps = makeDeps();
    const handler = getRouteHandler(createWebhookRouter(deps), '/webhooks/ghl');

    const req = {
      headers: { 'x-wh-signature': 'invalid-signature' },
      body: { type: 'contact.create', data: { id: '123' } },
    } as unknown as Request;
    const { res, statusCode, body } = mockRes();

    await handler(req, res);
    expect(statusCode()).toBe(401);
    expect(body()).toEqual({ error: 'Invalid webhook signature' });
  });

  it('GHL route accepts valid signature and stores event', async () => {
    const deps = makeDeps();
    const handler = getRouteHandler(createWebhookRouter(deps), '/webhooks/ghl');

    const reqBody = { type: 'contact.create', data: { id: '123' } };
    const rawBody = JSON.stringify(reqBody);
    const signature = sign(rawBody, 'webhook-secret');

    const req = {
      headers: { 'x-wh-signature': signature, 'content-type': 'application/json' },
      body: reqBody,
    } as unknown as Request;
    const { res, statusCode, body } = mockRes();

    await handler(req, res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ received: true });
    expect(deps.db.from).toHaveBeenCalledWith('webhook_events');
  });

  it('handler catches internal errors and returns 500', async () => {
    const deps = makeDeps({
      getWebhookSecret: vi.fn().mockRejectedValue(new Error('DB down')),
    });
    const handler = getRouteHandler(createWebhookRouter(deps), '/webhooks/ghl');

    const req = { headers: {}, body: {} } as Request;
    const { res, statusCode } = mockRes();

    await handler(req, res);
    expect(statusCode()).toBe(500);
  });

  it('emits webhook:received event on success', async () => {
    const deps = makeDeps();
    const handler = getRouteHandler(createWebhookRouter(deps), '/webhooks/ghl');

    const reqBody = { type: 'contact.create', data: { id: '123' } };
    const signature = sign(JSON.stringify(reqBody), 'webhook-secret');
    const req = {
      headers: { 'x-wh-signature': signature, 'content-type': 'application/json' },
      body: reqBody,
    } as unknown as Request;
    const { res } = mockRes();

    await handler(req, res);
    expect(deps.eventBus.emit).toHaveBeenCalledWith('webhook:received', expect.objectContaining({
      source: 'ghl',
      eventType: 'contact.create',
    }));
  });
});
