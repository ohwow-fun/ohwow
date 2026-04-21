/**
 * Eternal Systems — trustee notification stub.
 *
 * Writes a row to eternal_notifications and emits a structured WARN log.
 * Actual transport (email, SMS, webhook) is intentionally out of scope for
 * the initial implementation; the hook exists so a real transport can be
 * wired in without changing callers.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { EternalMode } from './types.js';

interface EternalNotificationRow {
  id: string;
  created_at: string;
  mode: string;
  reason: string;
  delivered: number;
}

/**
 * Notify the configured trustee about an eternal mode transition.
 * Persists the notification to eternal_notifications for audit and future
 * transport delivery. Non-fatal: errors are logged but never thrown.
 */
export async function notifyTrustee(
  db: DatabaseAdapter,
  mode: EternalMode,
  reason: string,
): Promise<void> {
  const id = randomUUID();
  const created_at = new Date().toISOString();

  logger.warn(
    { eternal_mode: mode, reason, notification_id: id },
    'eternal.trustee_notification',
  );

  try {
    await db.from<EternalNotificationRow>('eternal_notifications').insert({
      id,
      created_at,
      mode,
      reason,
      delivered: 0,
    });
  } catch (err) {
    logger.warn(
      { err, notification_id: id },
      'eternal.trustee_notification.persist.failed',
    );
  }
}
