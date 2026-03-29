/**
 * Webhook Relay Handler
 *
 * Processes webhooks relayed from the cloud via the local_runtime_commands
 * poll queue. Mirrors the logic in webhook-handler.ts but receives data from
 * the command payload instead of an HTTP request.
 *
 * Flow:
 * 1. Parse the relay payload (rawBody, headers, webhookType)
 * 2. For GHL: verify signature, store event, evaluate triggers
 * 3. For custom: look up trigger by token, store event, evaluate trigger
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { LocalTriggerEvaluator } from '../triggers/local-trigger-evaluator.js';
import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import type { WebhookRelayPayload } from '../control-plane/types.js';
import { verifyGhlSignature } from './signature.js';
import { LocalTriggerService } from '../triggers/local-trigger-service.js';
import { extractLeafPaths } from '../triggers/field-mapper.js';
import { logger } from '../lib/logger.js';

export interface WebhookRelayHandlerDeps {
  db: DatabaseAdapter;
  triggerEvaluator: LocalTriggerEvaluator;
  eventBus: TypedEventBus<RuntimeEvents>;
  getWebhookSecret: () => Promise<string | undefined>;
}

export class WebhookRelayHandler {
  private db: DatabaseAdapter;
  private triggerEvaluator: LocalTriggerEvaluator;
  private eventBus: TypedEventBus<RuntimeEvents>;
  private getWebhookSecret: () => Promise<string | undefined>;

  constructor(deps: WebhookRelayHandlerDeps) {
    this.db = deps.db;
    this.triggerEvaluator = deps.triggerEvaluator;
    this.eventBus = deps.eventBus;
    this.getWebhookSecret = deps.getWebhookSecret;
  }

  async handleRelay(payload: WebhookRelayPayload): Promise<void> {
    try {
      if (payload.webhookType === 'ghl') {
        await this.handleGhl(payload);
      } else {
        await this.handleCustom(payload);
      }
    } catch (err) {
      logger.error({ err }, '[WebhookRelay] Handler error');
    }
  }

  private async handleGhl(payload: WebhookRelayPayload): Promise<void> {
    // 1. Verify signature using the preserved raw body
    const secret = await this.getWebhookSecret();
    const signature = payload.headers['x-wh-signature'];

    if (!verifyGhlSignature(payload.rawBody, signature, secret)) {
      logger.warn('[WebhookRelay] Invalid GHL webhook signature');
      return;
    }

    // 2. Parse payload
    let body: { type?: string; data?: Record<string, unknown> };
    try {
      body = JSON.parse(payload.rawBody) as { type?: string; data?: Record<string, unknown> };
    } catch {
      logger.error('[WebhookRelay] Could not parse GHL raw body');
      return;
    }

    const eventType = body.type || 'unknown';

    // 3. Store raw event
    await this.db.from('webhook_events').insert({
      source: 'ghl',
      event_type: eventType,
      payload: payload.rawBody,
      headers: JSON.stringify(payload.headers),
      processed: 0,
    });

    // 4. Evaluate triggers (fire-and-forget)
    this.triggerEvaluator.evaluate('ghl', eventType, body.data || {}).catch((err) => {
      logger.error({ err }, '[WebhookRelay] GHL trigger evaluation error');
    });

    // 5. Emit event
    this.eventBus.emit('webhook:received', { source: 'ghl', eventType, payload: body });
  }

  private async handleCustom(payload: WebhookRelayPayload): Promise<void> {
    const token = payload.webhookToken;
    if (!token) {
      logger.warn('[WebhookRelay] Custom webhook relay missing token');
      return;
    }

    const triggerService = new LocalTriggerService(this.db);

    // 1. Look up trigger by webhook token
    const trigger = await triggerService.getByWebhookToken(token);
    if (!trigger) {
      logger.warn(`[WebhookRelay] Unknown webhook token: ${token}`);
      return;
    }

    // 2. Optional auth header check
    const config = safeParseJson(trigger.action_config);
    if (config.auth_header && config.auth_value) {
      const headerValue = payload.headers[String(config.auth_header).toLowerCase()];
      if (headerValue !== config.auth_value) {
        logger.warn('[WebhookRelay] Custom webhook auth check failed');
        return;
      }
    }

    // 3. Parse payload
    let body: Record<string, unknown>;
    try {
      body = payload.rawBody ? (JSON.parse(payload.rawBody) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }

    // 4. Store raw event
    await this.db.from('webhook_events').insert({
      source: 'custom',
      event_type: 'custom',
      payload: JSON.stringify(body),
      headers: JSON.stringify(payload.headers),
      processed: 0,
    });

    // 5. Extract leaf paths and update sample data
    const fields = extractLeafPaths(body);
    await triggerService.updateSampleData(trigger.id, JSON.stringify(body), fields);

    // 6. If trigger is enabled, dispatch async
    if (trigger.enabled) {
      this.triggerEvaluator.evaluateCustom(trigger, body).catch((err) => {
        logger.error({ err }, '[WebhookRelay] Custom trigger evaluation error');
      });
    }

    // 7. Emit event
    this.eventBus.emit('webhook:received', { source: 'custom', eventType: 'custom', payload: body, triggerId: trigger.id });
  }
}

function safeParseJson(val: unknown): Record<string, unknown> {
  if (typeof val === 'object' && val !== null) return val as Record<string, unknown>;
  try {
    return JSON.parse(val as string) as Record<string, unknown>;
  } catch {
    return {};
  }
}
