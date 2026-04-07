/**
 * Presence Routes — Local presence event ingestion
 * POST /api/presence/event — Accept presence events from the Eye (phone/browser)
 *
 * Events are forwarded to the PresenceEngine via the event bus.
 * No cloud, no Supabase, no polling. Direct and fast.
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';

const VALID_EVENT_TYPES = ['arrival', 'departure', 'still_here'];

export function createPresenceRouter(eventBus: TypedEventBus<RuntimeEvents>): Router {
  const router = Router();

  router.post('/api/presence/event', (req, res) => {
    const { eventType, confidence, deviceId } = req.body as {
      eventType?: string;
      confidence?: number;
      deviceId?: string;
    };

    if (!eventType || !VALID_EVENT_TYPES.includes(eventType)) {
      res.status(400).json({ error: 'eventType must be "arrival", "departure", or "still_here"' });
      return;
    }

    eventBus.emit('presence:event', {
      eventType: eventType as 'arrival' | 'departure' | 'still_here',
      confidence: confidence ?? 0.8,
      deviceId: deviceId || 'unknown',
      timestamp: Date.now(),
    });

    res.json({ ok: true });
  });

  return router;
}
