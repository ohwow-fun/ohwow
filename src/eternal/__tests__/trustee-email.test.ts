/**
 * Unit tests for createTrusteeNotifier.
 *
 * Covers email send, webhook fire-and-forget, delivered flag update,
 * and non-fatal error handling. Does not test resolveTrusteeNotifier
 * (that talks to DB/env and is an integration concern).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EmailSender, SendEmailResult } from '../../integrations/email/resend.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { createTrusteeNotifier } from '../trustee-email.js';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmailSender(result: SendEmailResult): EmailSender {
  return vi.fn().mockResolvedValue(result);
}

/**
 * Build a minimal DatabaseAdapter mock that supports the chained
 * .from().update().eq() pattern used by the notifier to set delivered=1.
 */
function buildMockDb(): { db: DatabaseAdapter; updateEq: ReturnType<typeof vi.fn> } {
  const updateEq = vi.fn().mockResolvedValue({ data: null, error: null });
  const updateBuilder = {
    eq: updateEq,
  };
  const tableBuilder = {
    update: vi.fn().mockReturnValue(updateBuilder),
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
  const db = {
    from: vi.fn().mockReturnValue(tableBuilder),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  } as unknown as DatabaseAdapter;
  return { db, updateEq };
}

const NOTIFICATION_ID = 'test-notification-id-abc';
const TO_ADDRESS = 'trustee@example.com';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createTrusteeNotifier', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('sends email with correct subject, mode in body, and idempotency key', async () => {
    const emailSender = makeEmailSender({ ok: true, providerId: 'resend-123' });
    const { db } = buildMockDb();
    const notifier = createTrusteeNotifier(emailSender, TO_ADDRESS);

    await notifier(db, NOTIFICATION_ID, 'conservative', 'inactivity: 8.0 days since last activity');

    expect(emailSender).toHaveBeenCalledTimes(1);
    const call = (emailSender as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.to).toBe(TO_ADDRESS);
    expect(call.subject).toBe('ohwow: runtime entering conservative mode');
    expect(call.text).toContain('conservative');
    expect(call.text).toContain('inactivity: 8.0 days since last activity');
    expect(call.idempotencyKey).toBe(`eternal:${NOTIFICATION_ID}`);
  });

  it('marks notification row delivered=1 on success', async () => {
    const emailSender = makeEmailSender({ ok: true, providerId: 'resend-456' });
    const { db, updateEq } = buildMockDb();
    const notifier = createTrusteeNotifier(emailSender, TO_ADDRESS);

    await notifier(db, NOTIFICATION_ID, 'estate', 'inactivity: 95.0 days since last activity');

    expect(db.from).toHaveBeenCalledWith('eternal_notifications');
    expect(updateEq).toHaveBeenCalledWith('id', NOTIFICATION_ID);
  });

  it('fires webhook POST when webhookUrl configured', async () => {
    const emailSender = makeEmailSender({ ok: true, providerId: 'resend-789' });
    const { db } = buildMockDb();
    const webhookUrl = 'https://hooks.example.com/eternal';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const notifier = createTrusteeNotifier(emailSender, TO_ADDRESS, webhookUrl);
    await notifier(db, NOTIFICATION_ID, 'conservative', 'test reason');

    // Allow the fire-and-forget promise to settle
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(webhookUrl);
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.event).toBe('eternal:mode_transition');
    expect(body.mode).toBe('conservative');
    expect(body.notification_id).toBe(NOTIFICATION_ID);
  });

  it('does NOT mark delivered when email send fails', async () => {
    const emailSender = makeEmailSender({ ok: false, reason: 'no_api_key' });
    const { db, updateEq } = buildMockDb();
    const notifier = createTrusteeNotifier(emailSender, TO_ADDRESS);

    await notifier(db, NOTIFICATION_ID, 'conservative', 'test reason');

    expect(updateEq).not.toHaveBeenCalled();
  });

  it('does NOT throw when webhook fails (fire-and-forget)', async () => {
    const emailSender = makeEmailSender({ ok: true, providerId: 'resend-abc' });
    const { db } = buildMockDb();
    const webhookUrl = 'https://hooks.example.com/eternal';
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const notifier = createTrusteeNotifier(emailSender, TO_ADDRESS, webhookUrl);

    // Should not throw even though webhook will fail
    await expect(
      notifier(db, NOTIFICATION_ID, 'estate', 'test reason'),
    ).resolves.toBeUndefined();

    // Allow the rejected promise to propagate and be caught
    await new Promise((r) => setTimeout(r, 0));
  });

  it('skips webhook when webhookUrl is undefined', async () => {
    const emailSender = makeEmailSender({ ok: true, providerId: 'resend-def' });
    const { db } = buildMockDb();
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const notifier = createTrusteeNotifier(emailSender, TO_ADDRESS);
    await notifier(db, NOTIFICATION_ID, 'conservative', 'test reason');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses estate-mode copy in email body when mode is estate', async () => {
    const emailSender = makeEmailSender({ ok: true, providerId: 'resend-ghi' });
    const { db } = buildMockDb();
    const notifier = createTrusteeNotifier(emailSender, TO_ADDRESS);

    await notifier(db, NOTIFICATION_ID, 'estate', 'inactivity: 100.0 days');

    const call = (emailSender as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.text).toContain('succession protocol');
    expect(call.text).not.toContain('ohwow eternal normal');
  });

  it('uses conservative-mode copy in email body when mode is conservative', async () => {
    const emailSender = makeEmailSender({ ok: true, providerId: 'resend-jkl' });
    const { db } = buildMockDb();
    const notifier = createTrusteeNotifier(emailSender, TO_ADDRESS);

    await notifier(db, NOTIFICATION_ID, 'conservative', 'inactivity: 10.0 days');

    const call = (emailSender as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.text).toContain('ohwow eternal normal');
    expect(call.text).not.toContain('succession protocol');
  });
});
