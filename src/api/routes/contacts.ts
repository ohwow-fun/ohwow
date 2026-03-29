/**
 * Contacts Routes
 * CRUD for agent_workforce_contacts + timeline from contact_events.
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

export function createContactsRouter(db: DatabaseAdapter, eventBus: TypedEventBus<RuntimeEvents>): Router {
  const router = Router();

  // List contacts
  router.get('/api/contacts', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_contacts')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Create contact
  router.post('/api/contacts', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { name, email, phone, company, contact_type, status, tags, custom_fields, notes } = req.body;

      if (!name) { res.status(400).json({ error: 'name is required' }); return; }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const { error } = await db.from('agent_workforce_contacts').insert({
        id, workspace_id: workspaceId, name,
        email: email || null, phone: phone || null, company: company || null,
        contact_type: contact_type || 'lead', status: status || 'active',
        tags: tags ? JSON.stringify(tags) : '[]',
        custom_fields: custom_fields ? JSON.stringify(custom_fields) : '{}',
        notes: notes || null, created_at: now, updated_at: now,
      });

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('agent_workforce_contacts')
        .select('*').eq('id', id).single();

      eventBus.emit('contact:upserted', created);
      res.status(201).json({ data: created });
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

  return router;
}
