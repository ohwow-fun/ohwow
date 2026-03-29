/**
 * Webhook Payload Schemas
 *
 * Zod schemas for validating inbound webhook payloads.
 */

import { z } from 'zod';

/** Generic webhook payload: requires at least an event type identifier */
export const WebhookPayloadSchema = z.object({
  type: z.string().optional(),
  event: z.string().optional(),
}).passthrough();

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;
