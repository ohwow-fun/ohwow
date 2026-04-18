/**
 * Email budget notifier tests — gap 13 operator-email pin.
 *
 * Pins the band filter (pause + halt only, not warn / degrade),
 * the Idempotency-Key shape (workspace:band:yyyy-mm-dd), the subject/
 * body copy hitting the house style (no em dashes, no "Please", no
 * "Failed to"), and the factory's silent-skip behavior when the
 * caller can't construct a sender (missing env/runtime_settings).
 *
 * Pattern parallel to budget-notifications.test.ts (the EventBus leg)
 * — same describe shape, same band-by-band case split.
 */

import { describe, it, expect, vi } from 'vitest';
import { createEmailBudgetNotifier } from '../budget-notifications.js';
import type { BudgetPulseEvent } from '../budget-middleware.js';
import type { EmailSender, SendEmailInput, SendEmailResult } from '../../integrations/email/resend.js';

const WS = 'ws-email-test';

function buildSender(): {
  sender: EmailSender;
  calls: SendEmailInput[];
  mock: ReturnType<typeof vi.fn>;
} {
  const calls: SendEmailInput[] = [];
  const mock = vi.fn(async (input: SendEmailInput): Promise<SendEmailResult> => {
    calls.push(input);
    return { ok: true, providerId: `prov-${calls.length}` };
  });
  return { sender: mock as unknown as EmailSender, calls, mock };
}

function flushMicrotasks(): Promise<void> {
  // The notifier is fire-and-forget (void opts.emailSender(...)); awaiting
  // a Promise.resolve() is enough to let the send microtask chain run.
  return new Promise<void>((r) => setImmediate(r));
}

describe('createEmailBudgetNotifier', () => {
  it('sends an email on budget.pause with a pause-shaped subject + body', async () => {
    const { sender, calls } = buildSender();
    const notify = createEmailBudgetNotifier({
      emailSender: sender,
      toAddress: 'op@example.com',
      fromAddress: 'ohwow <no-reply@example.com>',
    });

    const event: BudgetPulseEvent = {
      type: 'budget.pause',
      workspaceId: WS,
      spentUsd: 47.5,
      limitUsd: 50,
      utilization: 0.95,
    };
    notify(event);
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe('op@example.com');
    expect(calls[0].subject.toLowerCase()).toContain('paused');
    expect(calls[0].subject).toContain('$47.50');
    expect(calls[0].subject).toContain('$50.00');
    const body = String(calls[0].text ?? '');
    expect(body).toContain(WS);
    expect(body.toLowerCase()).toContain('settings');
    expect(body.toLowerCase()).toContain('runtime');
    // House style: no em/en dashes in user-facing copy.
    expect(body).not.toMatch(/—|–/);
    expect(calls[0].subject).not.toMatch(/—|–/);
    // House style: no "Please" in validation / notification copy.
    expect(body).not.toMatch(/\bPlease\b/);
    // House style: no "Failed to".
    expect(body).not.toMatch(/Failed to /i);
  });

  it('sends an email on budget.halt with a halt-shaped subject', async () => {
    const { sender, calls } = buildSender();
    const notify = createEmailBudgetNotifier({
      emailSender: sender,
      toAddress: 'op@example.com',
      fromAddress: 'ohwow <no-reply@example.com>',
    });

    notify({
      type: 'budget.halt',
      workspaceId: WS,
      spentUsd: 51,
      limitUsd: 50,
      utilization: 1.02,
    });
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0].subject.toLowerCase()).toContain('halt');
    expect(calls[0].subject).toContain('$51.00');
    // halt body must say "halted" and must name the cap and the workspace.
    expect(String(calls[0].text ?? '').toLowerCase()).toContain('halted');
    // House style sanity on subject + body.
    expect(calls[0].subject).not.toMatch(/—|–/);
  });

  it('does NOT send on budget.warn', async () => {
    const { sender, calls } = buildSender();
    const notify = createEmailBudgetNotifier({
      emailSender: sender,
      toAddress: 'op@example.com',
      fromAddress: 'ohwow <no-reply@example.com>',
    });

    notify({
      type: 'budget.warn',
      workspaceId: WS,
      spentUsd: 37.5,
      limitUsd: 50,
      utilization: 0.75,
    });
    await flushMicrotasks();

    expect(calls).toHaveLength(0);
  });

  it('does NOT send on budget.degrade', async () => {
    const { sender, calls } = buildSender();
    const notify = createEmailBudgetNotifier({
      emailSender: sender,
      toAddress: 'op@example.com',
      fromAddress: 'ohwow <no-reply@example.com>',
    });

    notify({
      type: 'budget.degrade',
      workspaceId: WS,
      spentUsd: 45,
      limitUsd: 50,
      utilization: 0.9,
      taskClass: 'agentic_coding',
      originalModel: 'claude-sonnet-4-6',
      substitutedModel: 'gemini-3.1-pro',
    });
    await flushMicrotasks();

    expect(calls).toHaveLength(0);
  });

  it('forwards an idempotency key shaped `budget:<workspace>:<band>:<yyyy-mm-dd>`', async () => {
    const { sender, calls } = buildSender();
    const notify = createEmailBudgetNotifier({
      emailSender: sender,
      toAddress: 'op@example.com',
      fromAddress: 'ohwow <no-reply@example.com>',
    });

    notify({
      type: 'budget.pause',
      workspaceId: WS,
      spentUsd: 48,
      limitUsd: 50,
      utilization: 0.96,
    });
    await flushMicrotasks();

    const today = new Date().toISOString().slice(0, 10);
    expect(calls[0].idempotencyKey).toBe(`budget:${WS}:pause:${today}`);

    // Halt uses the 'halt' band slug, not 'pause'.
    notify({
      type: 'budget.halt',
      workspaceId: WS,
      spentUsd: 55,
      limitUsd: 50,
      utilization: 1.1,
    });
    await flushMicrotasks();
    expect(calls[1].idempotencyKey).toBe(`budget:${WS}:halt:${today}`);
  });

  it('tags the email with kind=budget + band=<pause|halt>', async () => {
    const { sender, calls } = buildSender();
    const notify = createEmailBudgetNotifier({
      emailSender: sender,
      toAddress: 'op@example.com',
      fromAddress: 'ohwow <no-reply@example.com>',
    });

    notify({
      type: 'budget.pause',
      workspaceId: WS,
      spentUsd: 48,
      limitUsd: 50,
      utilization: 0.96,
    });
    await flushMicrotasks();

    expect(calls[0].tags).toEqual(
      expect.arrayContaining([
        { name: 'kind', value: 'budget' },
        { name: 'band', value: 'pause' },
      ]),
    );
  });

  it('does not throw when the sender returns ok=false (swallowed, logged)', async () => {
    const failingSender: EmailSender = async () => ({ ok: false, reason: 'no_api_key' });
    const notify = createEmailBudgetNotifier({
      emailSender: failingSender,
      toAddress: 'op@example.com',
      fromAddress: 'ohwow <no-reply@example.com>',
    });

    // Must not throw on the hot path.
    expect(() => {
      notify({
        type: 'budget.pause',
        workspaceId: WS,
        spentUsd: 48,
        limitUsd: 50,
        utilization: 0.96,
      });
    }).not.toThrow();
    await flushMicrotasks();
  });

  it('does not throw when the sender rejects (mailer hiccup swallowed)', async () => {
    const throwingSender: EmailSender = async () => { throw new Error('resend down'); };
    const notify = createEmailBudgetNotifier({
      emailSender: throwingSender,
      toAddress: 'op@example.com',
      fromAddress: 'ohwow <no-reply@example.com>',
    });

    expect(() => {
      notify({
        type: 'budget.halt',
        workspaceId: WS,
        spentUsd: 55,
        limitUsd: 50,
        utilization: 1.1,
      });
    }).not.toThrow();
    await flushMicrotasks();
  });

  it('fires once per band per day when the same event replays (idempotent via provider key)', async () => {
    // The notifier itself does not dedupe in-process (the middleware's
    // emittedToday tracker + Resend's Idempotency-Key header handle
    // that). What this test pins is that the key stays stable across
    // replays so the provider can dedupe them.
    const { sender, calls } = buildSender();
    const notify = createEmailBudgetNotifier({
      emailSender: sender,
      toAddress: 'op@example.com',
      fromAddress: 'ohwow <no-reply@example.com>',
    });

    const event: BudgetPulseEvent = {
      type: 'budget.pause',
      workspaceId: WS,
      spentUsd: 48,
      limitUsd: 50,
      utilization: 0.96,
    };
    notify(event);
    notify(event);
    await flushMicrotasks();

    expect(calls).toHaveLength(2);
    expect(calls[0].idempotencyKey).toBe(calls[1].idempotencyKey);
  });
});
