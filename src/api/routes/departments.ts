/**
 * Departments Routes
 * CRUD for agent_workforce_departments.
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

export function createDepartmentsRouter(db: DatabaseAdapter, eventBus: TypedEventBus<RuntimeEvents>): Router {
  const router = Router();

  // List departments
  router.get('/api/departments', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_departments')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('sort_order');

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Create department
  router.post('/api/departments', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { name, color, description, sort_order } = req.body;

      if (!name) { res.status(400).json({ error: 'name is required' }); return; }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const { error } = await db.from('agent_workforce_departments').insert({
        id, workspace_id: workspaceId, name,
        color: color || null, description: description || null,
        sort_order: sort_order ?? 0, created_at: now, updated_at: now,
      });

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('agent_workforce_departments')
        .select('*').eq('id', id).single();

      eventBus.emit('department:upserted', created);
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Update department
  router.put('/api/departments/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const updates = { ...req.body, updated_at: new Date().toISOString() };
      delete updates.id; delete updates.workspace_id;

      const { error } = await db.from('agent_workforce_departments')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: updated } = await db.from('agent_workforce_departments')
        .select('*').eq('id', req.params.id).single();

      eventBus.emit('department:upserted', updated);
      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delete department
  router.delete('/api/departments/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { error } = await db.from('agent_workforce_departments')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) { res.status(500).json({ error: error.message }); return; }
      eventBus.emit('department:removed', { id: req.params.id });
      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
