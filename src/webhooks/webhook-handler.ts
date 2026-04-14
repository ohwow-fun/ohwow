/**
 * Webhook Handler
 *
 * Express router for receiving external webhooks (e.g., GoHighLevel).
 * Mounted BEFORE auth middleware since this is a public endpoint.
 *
 * Flow:
 * 1. Verify signature (if secret configured)
 * 2. Parse payload
 * 3. Store raw event in webhook_events table
 * 4. Respond 200 OK immediately
 * 5. Async: pass to trigger evaluator
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { LocalTriggerEvaluator } from '../triggers/local-trigger-evaluator.js';
import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import { verifyGhlSignature } from './signature.js';
import { LocalTriggerService } from '../triggers/local-trigger-service.js';
import { extractLeafPaths } from '../triggers/field-mapper.js';
import { logger } from '../lib/logger.js';

export interface WebhookHandlerDeps {
  db: DatabaseAdapter;
  triggerEvaluator: LocalTriggerEvaluator;
  eventBus: TypedEventBus<RuntimeEvents>;
  /** Returns the GHL webhook secret from runtime_settings, or undefined if not set */
  getWebhookSecret: () => Promise<string | undefined>;
}

export function createWebhookRouter(deps: WebhookHandlerDeps): Router {
  const { db, triggerEvaluator, eventBus, getWebhookSecret } = deps;
  const router = Router();

  // Use raw body for signature verification
  router.post('/webhooks/ghl', async (req, res) => {
    try {
      // 1. Verify signature
      const secret = await getWebhookSecret();
      const signature = req.headers['x-wh-signature'] as string | undefined;
      const rawBody = JSON.stringify(req.body);

      if (!verifyGhlSignature(rawBody, signature, secret)) {
        res.status(401).json({ error: 'Invalid webhook signature' });
        return;
      }

      // 2. Parse payload
      const body = req.body as { type?: string; timestamp?: string; webhookId?: string; data?: Record<string, unknown> };
      const eventType = body.type || 'unknown';
      const payload = body;

      // 3. Store raw event
      const eventId = crypto.randomUUID().replace(/-/g, '');
      await db.from('webhook_events').insert({
        id: eventId,
        source: 'ghl',
        event_type: eventType,
        payload: JSON.stringify(payload),
        headers: JSON.stringify({
          'x-wh-signature': signature || null,
          'content-type': req.headers['content-type'],
        }),
        processed: 0,
      });

      // 4. Respond immediately
      res.status(200).json({ received: true });

      // 5. Async: evaluate triggers, then mark the row processed so the
      // Webhook Events audit UI reflects actual state instead of stranding
      // every event at "pending" forever.
      void triggerEvaluator.evaluate('ghl', eventType, payload.data || {})
        .catch((err) => {
          logger.error(`[Webhook] Trigger evaluation error: ${err}`);
        })
        .finally(async () => {
          try {
            await db.from('webhook_events')
              .update({ processed: 1 })
              .eq('id', eventId);
          } catch (err) {
            logger.warn({ err, eventId }, '[Webhook] Failed to mark ghl event processed');
          }
        });

      // 6. Emit event on bus
      eventBus.emit('webhook:received', { source: 'ghl', eventType, payload });
    } catch (err) {
      logger.error(`[Webhook] Handler error: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Custom webhook endpoint — per-trigger URLs
  router.post('/webhooks/incoming/:token', async (req, res) => {
    try {
      const { token } = req.params;
      const triggerService = new LocalTriggerService(db);

      // 1. Look up trigger by webhook token
      const trigger = await triggerService.getByWebhookToken(token);
      if (!trigger) {
        res.status(404).json({ error: 'Unknown webhook token' });
        return;
      }

      // 2. Optional auth header check
      logger.debug(`[WebhookHandler] action_config type=${typeof trigger.action_config} ${JSON.stringify(trigger.action_config)}`);
      const config = safeParseJson(trigger.action_config);
      if (config.auth_header && config.auth_value) {
        const headerValue = req.headers[String(config.auth_header).toLowerCase()];
        if (headerValue !== config.auth_value) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
      }

      // 3. Parse payload (handle empty/null body)
      const payload = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};

      // 4. Store raw event
      const eventId = crypto.randomUUID().replace(/-/g, '');
      await db.from('webhook_events').insert({
        id: eventId,
        source: 'custom',
        event_type: 'custom',
        payload: JSON.stringify(payload),
        headers: JSON.stringify({
          'content-type': req.headers['content-type'],
        }),
        processed: 0,
      });

      // 5. Extract leaf paths and update sample data
      const fields = extractLeafPaths(payload);
      await triggerService.updateSampleData(trigger.id, JSON.stringify(payload), fields);

      // 6. Respond immediately
      res.status(200).json({ received: true, fields_discovered: fields.length });

      // 7. If trigger is enabled, dispatch async and mark the row processed
      // on completion. Disabled triggers get marked immediately — no work to
      // do, and the audit UI shouldn't strand them at "pending" forever.
      const markProcessed = async (label: string) => {
        try {
          await db.from('webhook_events')
            .update({ processed: 1 })
            .eq('id', eventId);
        } catch (err) {
          logger.warn({ err, eventId }, `[Webhook] Failed to mark ${label} event processed`);
        }
      };
      if (trigger.enabled) {
        void triggerEvaluator.evaluateCustom(trigger, payload)
          .catch((err) => {
            logger.error(`[Webhook] Custom trigger evaluation error: ${err}`);
          })
          .finally(() => { void markProcessed('custom'); });
      } else {
        void markProcessed('disabled-trigger');
      }

      // 8. Emit event
      eventBus.emit('webhook:received', { source: 'custom', eventType: 'custom', payload, triggerId: trigger.id });
    } catch (err) {
      logger.error(`[Webhook] Custom handler error: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}

function safeParseJson(val: unknown): Record<string, unknown> {
  if (typeof val === 'object' && val !== null) return val as Record<string, unknown>;
  try {
    return JSON.parse(val as string) as Record<string, unknown>;
  } catch {
    return {};
  }
}
