/**
 * Contacts Routes
 * CRUD for agent_workforce_contacts + timeline from contact_events.
 *
 * Every mutating path fires a fire-and-forget upstream sync via the
 * control plane so the cloud dashboard and cloud agents see the same
 * contact state. Sync failures are logged and queued, never surfaced
 * to the caller.
 *
 * Rows written with `never_sync=1` are treated as workspace-local PII
 * (e.g. public-profile data harvested from X). They skip the upstream
 * sync path entirely. The invariant lives at two layers: this route
 * short-circuits `syncContact`, and `sync-resources.syncResource` also
 * refuses to ship a payload whose `never_sync` flag is set. Events for
 * such contacts must not grow a sync dispatcher — the legacy sync map
 * has no entry for `contact_event`, and adding one would require
 * auditing the never_sync path first.
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ControlPlaneClient } from '../../control-plane/client.js';
import { logger } from '../../lib/logger.js';

/** Whitelist a custom_field key before interpolating it into a json_extract() expression. */
const CUSTOM_FIELD_KEY_RE = /^[a-zA-Z0-9_]{1,64}$/;

export function createContactsRouter(
  db: DatabaseAdapter,
  eventBus: TypedEventBus<RuntimeEvents>,
  controlPlane?: ControlPlaneClient | null,
): Router {
  const router = Router();

  /** Fire-and-forget sync helper. Never throws, never blocks. Respects never_sync. */
  const syncContact = (action: 'upsert' | 'delete', payload: Record<string, unknown> & { id: string }) => {
    if (!controlPlane) return;
    if (payload.never_sync === 1 || payload.never_sync === true) return;
    controlPlane
      .reportResource('contact', action, payload)
      .catch((err) => {
        logger.warn({ err, action, id: payload.id }, '[contacts] upstream sync threw');
      });
  };

  // List contacts. Supports custom_field_key + custom_field_value for
  // server-side filtering against a JSON path on custom_fields. Key is
  // allowlisted to [a-zA-Z0-9_] so it's safe to interpolate into the
  // json_extract() expression; value goes through the bound-param path.
  router.get('/api/contacts', async (req, res) => {
    try {
      const { workspaceId } = req;
      const cfKey = typeof req.query.custom_field_key === 'string' ? req.query.custom_field_key : null;
      const cfValue = typeof req.query.custom_field_value === 'string' ? req.query.custom_field_value : null;
      if (cfKey && !CUSTOM_FIELD_KEY_RE.test(cfKey)) {
        res.status(400).json({ error: 'custom_field_key must match [a-zA-Z0-9_]{1,64}' });
        return;
      }

      let query = db.from('agent_workforce_contacts')
        .select('*')
        .eq('workspace_id', workspaceId);
      if (cfKey && cfValue !== null) {
        query = query.eq(`json_extract(custom_fields, '$.${cfKey}')`, cfValue);
      }
      const { data, error } = await query.order('created_at', { ascending: false });

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Create contact. Accepts never_sync + outreach_token for X-sourced
  // workspace-local contacts that must not leave the machine.
  router.post('/api/contacts', async (req, res) => {
    try {
      const { workspaceId } = req;
      const {
        name, email, phone, company, contact_type, status, tags, custom_fields, notes,
        never_sync, outreach_token,
      } = req.body;

      if (!name) { res.status(400).json({ error: 'name is required' }); return; }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const neverSyncFlag = never_sync === true || never_sync === 1 ? 1 : 0;

      const { error } = await db.from('agent_workforce_contacts').insert({
        id, workspace_id: workspaceId, name,
        email: email || null, phone: phone || null, company: company || null,
        contact_type: contact_type || 'lead', status: status || 'active',
        tags: tags ? JSON.stringify(tags) : '[]',
        custom_fields: custom_fields ? JSON.stringify(custom_fields) : '{}',
        notes: notes || null,
        never_sync: neverSyncFlag,
        outreach_token: outreach_token || null,
        created_at: now, updated_at: now,
      });

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('agent_workforce_contacts')
        .select('*').eq('id', id).single();

      eventBus.emit('contact:upserted', created);
      if (created) {
        syncContact('upsert', created as Record<string, unknown> & { id: string });
      }
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get single contact by id, scoped to the caller's workspace so an
  // attacker who guesses an id from another workspace can't read PII.
  router.get('/api/contacts/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_contacts')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .maybeSingle();

      if (error) { res.status(500).json({ error: error.message }); return; }
      if (!data) { res.status(404).json({ error: 'contact not found' }); return; }
      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Update contact
  router.put('/api/contacts/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const updates = { ...req.body, updated_at: new Date().toISOString() };
      if (updates.tags && typeof updates.tags !== 'string') updates.tags = JSON.stringify(updates.tags);
      if (updates.custom_fields && typeof updates.custom_fields !== 'string') updates.custom_fields = JSON.stringify(updates.custom_fields);
      delete updates.id; delete updates.workspace_id;

      const { error } = await db.from('agent_workforce_contacts')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: updated } = await db.from('agent_workforce_contacts')
        .select('*').eq('id', req.params.id).single();

      eventBus.emit('contact:upserted', updated);
      if (updated) {
        syncContact('upsert', updated as Record<string, unknown> & { id: string });
      }
      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delete contact
  router.delete('/api/contacts/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { error } = await db.from('agent_workforce_contacts')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) { res.status(500).json({ error: error.message }); return; }
      eventBus.emit('contact:removed', { id: req.params.id });
      syncContact('delete', { id: req.params.id });
      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Contact timeline (events)
  router.get('/api/contacts/:id/timeline', async (req, res) => {
    try {
      const { data, error } = await db.from('agent_workforce_contact_events')
        .select('*')
        .eq('contact_id', req.params.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Append a sales-loop event. Writes the 121-shape columns (kind, source,
  // payload, occurred_at) AND the legacy 001-shape columns (event_type,
  // title, metadata, created_at) so existing readers (contact-detail.tsx,
  // contact-pipeline.ts, daily-reps.ts) and new sales-loop readers can
  // both render the row without a schema flag day. `kind` doubles as the
  // legacy event_type; `title` defaults to `kind` if not provided.
  router.post('/api/contacts/:id/events', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { kind, source, payload, title } = req.body;
      if (!kind || typeof kind !== 'string') {
        res.status(400).json({ error: 'kind is required' });
        return;
      }

      const { data: contact } = await db.from('agent_workforce_contacts')
        .select('id, workspace_id').eq('id', req.params.id).maybeSingle();
      if (!contact) { res.status(404).json({ error: 'contact not found' }); return; }
      if ((contact as { workspace_id: string }).workspace_id !== workspaceId) {
        res.status(404).json({ error: 'contact not found' });
        return;
      }

      const payloadJson = payload ? JSON.stringify(payload) : '{}';
      const now = new Date().toISOString();
      const { error } = await db.from('agent_workforce_contact_events').insert({
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        contact_id: req.params.id,
        kind,
        source: source || null,
        payload: payloadJson,
        occurred_at: now,
        // Legacy columns: both NOT NULL on 001-era DBs.
        event_type: kind,
        title: title || kind,
        metadata: payloadJson,
        created_at: now,
      });

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.status(201).json({ data: { ok: true } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
