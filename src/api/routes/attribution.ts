/**
 * Attribution Routes
 *
 * Public landing endpoint that closes the outreach-token → funnel-event
 * loop. A link in an outbound message (DM, email, tweet reply) embeds
 * `?t=<contact.outreach_token>`; when the recipient clicks it, this
 * endpoint looks the contact up, records the hit as a contact_event,
 * and 302-redirects to a config-driven target. The hit itself IS the
 * attribution ground truth — every downstream funnel query reads
 * contact_events, and this is the only thing that writes the
 * intermediate kinds (x:reached, demo:booked, trial:started).
 *
 * No auth: the token IS the auth. A leaked token can at worst record
 * duplicate hits against one contact; the 24h per-(contact, kind)
 * dedup window caps that noise.
 *
 * Kill switch: runtime_config key `attribution.tracking_enabled`
 * (default true). When set to false, the endpoint still 302-redirects
 * so an outbound link never 500s, but skips the DB write — useful if
 * the operator needs to pause attribution without breaking public
 * links.
 *
 * Redirect target: runtime_config key `attribution.redirect_url`
 * (default `https://ohwow.fun/`). Operators can steer hits to a
 * campaign-specific landing page without a code change.
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';
import { getRuntimeConfig } from '../../self-bench/runtime-config.js';

/** Events the endpoint accepts via `?e=`. Unknown values fall back to x:reached. */
export const ATTRIBUTION_EVENT_SAFELIST = new Set<string>([
  'x:reached',
  'demo:booked',
  'trial:started',
  'plan:paid',
]);

const DEFAULT_EVENT = 'x:reached';
const DEFAULT_REDIRECT_URL = 'https://ohwow.fun/';
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRACKING_ENABLED_KEY = 'attribution.tracking_enabled';
const REDIRECT_URL_KEY = 'attribution.redirect_url';

interface ContactRow {
  id: string;
  workspace_id: string;
}

interface EventRow {
  id: string;
  created_at: string | null;
}

export function createAttributionRouter(db: DatabaseAdapter): Router {
  const router = Router();

  router.get('/api/attribution/hit', async (req, res) => {
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    const rawEvent = typeof req.query.e === 'string' ? req.query.e : '';
    const kind = ATTRIBUTION_EVENT_SAFELIST.has(rawEvent) ? rawEvent : DEFAULT_EVENT;
    const redirectUrl = getRuntimeConfig<string>(REDIRECT_URL_KEY, DEFAULT_REDIRECT_URL);

    // Empty-token links still redirect so a mistyped outbound URL
    // doesn't surface a public 400. The miss is logged for operator
    // audit rather than returned to the caller.
    if (!token) {
      logger.debug('[attribution] hit without token — redirecting without write');
      res.redirect(302, redirectUrl);
      return;
    }

    const trackingEnabled = getRuntimeConfig<boolean>(TRACKING_ENABLED_KEY, true);

    try {
      const { data } = await db
        .from<ContactRow>('agent_workforce_contacts')
        .select('id, workspace_id')
        .eq('outreach_token', token)
        .limit(1);
      const rows = (data ?? []) as ContactRow[];
      const contact = rows[0];

      if (!contact) {
        logger.debug({ tokenPrefix: token.slice(0, 8) }, '[attribution] token did not match a contact');
        res.redirect(302, redirectUrl);
        return;
      }

      if (!trackingEnabled) {
        logger.info({ contactId: contact.id, kind }, '[attribution] tracking disabled — redirecting without write');
        res.redirect(302, redirectUrl);
        return;
      }

      const cutoffIso = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
      const { data: priorData } = await db
        .from<EventRow>('agent_workforce_contact_events')
        .select('id, created_at')
        .eq('contact_id', contact.id)
        .eq('kind', kind)
        .gte('created_at', cutoffIso)
        .limit(1);
      const prior = ((priorData ?? []) as EventRow[])[0];

      if (prior) {
        logger.debug(
          { contactId: contact.id, kind, priorEventId: prior.id },
          '[attribution] dedup hit within 24h window',
        );
        res.redirect(302, redirectUrl);
        return;
      }

      const nowIso = new Date().toISOString();
      const payloadJson = JSON.stringify({
        query_event: rawEvent || null,
        referer: req.get('referer') || null,
        user_agent: (req.get('user-agent') ?? '').slice(0, 256),
      });
      await db.from('agent_workforce_contact_events').insert({
        id: crypto.randomUUID(),
        workspace_id: contact.workspace_id,
        contact_id: contact.id,
        kind,
        source: 'attribution',
        payload: payloadJson,
        occurred_at: nowIso,
        event_type: kind,
        title: kind,
        metadata: payloadJson,
        created_at: nowIso,
      });

      logger.info({ contactId: contact.id, kind }, '[attribution] recorded hit');
      res.redirect(302, redirectUrl);
    } catch (err) {
      logger.error({ err }, '[attribution] handler failed');
      res.redirect(302, redirectUrl);
    }
  });

  return router;
}
