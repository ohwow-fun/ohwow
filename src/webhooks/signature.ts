/**
 * GHL Webhook Signature Verification
 *
 * GoHighLevel signs webhook payloads using HMAC-SHA256.
 * The signature is sent in the `x-wh-signature` header.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { logger } from '../lib/logger.js';

/**
 * Verify the GHL webhook signature against the raw body.
 * Returns true if the signature is valid, false otherwise.
 *
 * If no secret is configured, returns false (reject unverifiable requests).
 */
export function verifyGhlSignature(
  rawBody: string | Buffer,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  // No secret configured — reject (cannot verify authenticity)
  if (!secret) {
    logger.warn('[GHL Webhook] No webhook secret configured. All GHL webhooks will be rejected. Configure ghl_webhook_secret in Settings.');
    return false;
  }

  // Secret is configured but no signature was provided
  if (!signature) return false;

  const expected = createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  try {
    return timingSafeEqual(
      Buffer.from(signature, 'utf-8'),
      Buffer.from(expected, 'utf-8'),
    );
  } catch {
    return false;
  }
}
