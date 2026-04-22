/**
 * Eternal Systems — trustee email/webhook notifier.
 *
 * Factory and resolver for delivering real mode-transition notifications
 * to the configured trustee. Follows the same pattern as budget-notifications.ts.
 */
import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { EmailSender } from '../integrations/email/resend.js';
import { createResendSender } from '../integrations/email/resend.js';
import type { EternalMode, EternalSpec } from './types.js';

export type TrusteeNotifier = (
  db: DatabaseAdapter,
  notificationId: string,
  mode: EternalMode,
  reason: string,
) => Promise<void>;

/**
 * Build a TrusteeNotifier from a ready EmailSender.
 * Sends email, optionally fires webhook, marks the notification row delivered.
 */
export function createTrusteeNotifier(
  emailSender: EmailSender,
  toAddress: string,
  webhookUrl?: string,
): TrusteeNotifier {
  return async (db, notificationId, mode, reason) => {
    // Email
    const result = await emailSender({
      to: toAddress,
      subject: `ohwow: runtime entering ${mode} mode`,
      text: [
        `Your ohwow runtime has shifted to ${mode} mode.`,
        '',
        `Reason: ${reason}`,
        '',
        mode === 'conservative'
          ? 'Autonomous work is paused. To restore: ohwow eternal normal'
          : 'Estate mode is active. The trustee should review the succession protocol.',
      ].join('\n'),
      idempotencyKey: `eternal:${notificationId}`,
      tags: [
        { name: 'kind', value: 'eternal' },
        { name: 'mode', value: mode },
      ],
    });

    if (!result.ok) {
      logger.warn(
        { reason: result.reason, mode, notificationId },
        'eternal.trustee_notify.email.failed',
      );
      return;
    }

    // Optional webhook — fire-and-forget, non-fatal
    if (webhookUrl) {
      globalThis.fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'eternal:mode_transition',
          mode,
          reason,
          notification_id: notificationId,
          timestamp: new Date().toISOString(),
        }),
      }).catch((err) =>
        logger.warn({ err, webhookUrl }, 'eternal.trustee_notify.webhook.failed'),
      );
    }

    // Mark delivered — best-effort, non-fatal
    try {
      await db
        .from<{ id: string; delivered: number }>('eternal_notifications')
        .update({ delivered: 1 })
        .eq('id', notificationId);
    } catch (err) {
      logger.warn({ err, notificationId }, 'eternal.trustee_notify.mark_delivered.failed');
    }

    logger.info({ mode, notificationId, to: toAddress }, 'eternal.trustee_notify.sent');
  };
}

/**
 * Resolve a TrusteeNotifier at daemon boot. Returns undefined when
 * required config is missing (graceful skip, logged at info level).
 *
 * Priority (highest first):
 *   trustee email  — spec.trustee.emailAddress | OHWOW_ETERNAL_TRUSTEE_EMAIL | runtime_settings.eternal_trustee_email
 *   API key        — RESEND_API_KEY | runtime_settings.resend_api_key
 *   from address   — OHWOW_OUTREACH_EMAIL_FROM | runtime_settings.outreach_email_from
 */
export async function resolveTrusteeNotifier(
  db: DatabaseAdapter,
  eternalSpec: EternalSpec,
): Promise<TrusteeNotifier | undefined> {
  const readSetting = async (key: string): Promise<string | undefined> => {
    try {
      const { data } = await db
        .from<{ value: string }>('runtime_settings')
        .select('value')
        .eq('key', key)
        .maybeSingle();
      return (data as { value: string } | null)?.value || undefined;
    } catch {
      return undefined;
    }
  };

  const trusteeEmail =
    eternalSpec.trustee?.emailAddress ||
    process.env.OHWOW_ETERNAL_TRUSTEE_EMAIL ||
    (await readSetting('eternal_trustee_email'));

  const apiKey =
    process.env.RESEND_API_KEY || (await readSetting('resend_api_key'));

  const fromAddress =
    process.env.OHWOW_OUTREACH_EMAIL_FROM || (await readSetting('outreach_email_from'));

  if (!trusteeEmail || !apiKey || !fromAddress) {
    logger.info(
      {
        hasTrusteeEmail: Boolean(trusteeEmail),
        hasApiKey: Boolean(apiKey),
        hasFromAddress: Boolean(fromAddress),
      },
      '[eternal] trustee email notifier skipped; set OHWOW_ETERNAL_TRUSTEE_EMAIL + RESEND_API_KEY + OHWOW_OUTREACH_EMAIL_FROM (or matching runtime_settings) to enable',
    );
    return undefined;
  }

  const emailSender = createResendSender({
    getApiKey: async () => apiKey,
    fromAddress,
  });

  logger.info(
    { to: trusteeEmail, from: fromAddress, hasWebhook: Boolean(eternalSpec.trustee?.webhookUrl) },
    '[eternal] trustee notifier wired',
  );

  return createTrusteeNotifier(emailSender, trusteeEmail, eternalSpec.trustee?.webhookUrl);
}
