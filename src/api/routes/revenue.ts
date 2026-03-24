/**
 * Revenue Routes
 * CRUD for agent_workforce_revenue_entries.
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

export function createRevenueRouter(db: DatabaseAdapter, _eventBus: TypedEventBus<RuntimeEvents>): Router {
  const router = Router();

  // List revenue entries
  router.get('/api/revenue', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_revenue_entries')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('year', { ascending: false });

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Create revenue entry
  router.post('/api/revenue', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { amount_cents, month, year, source, notes } = req.body;

      if (amount_cents == null || !month || !year) {
        res.status(400).json({ error: 'amount_cents, month, and year are required' });
        return;
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const { error } = await db.from('agent_workforce_revenue_entries').insert({
        id, workspace_id: workspaceId,
        amount_cents, month, year,
        source: source || null, notes: notes || null,
        created_at: now, updated_at: now,
      });

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('agent_workforce_revenue_entries')
        .select('*').eq('id', id).single();

      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Update revenue entry
  router.put('/api/revenue/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const updates = { ...req.body, updated_at: new Date().toISOString() };
      delete updates.id; delete updates.workspace_id;

      const { error } = await db.from('agent_workforce_revenue_entries')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: updated } = await db.from('agent_workforce_revenue_entries')
        .select('*').eq('id', req.params.id).single();

      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delete revenue entry
  router.delete('/api/revenue/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { error } = await db.from('agent_workforce_revenue_entries')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
