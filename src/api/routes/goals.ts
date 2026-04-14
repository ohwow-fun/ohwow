/**
 * Goals Routes
 * CRUD for agent_workforce_goals.
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

export function createGoalsRouter(db: DatabaseAdapter, _eventBus: TypedEventBus<RuntimeEvents>): Router {
  const router = Router();

  // List goals
  router.get('/api/goals', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_goals')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('position', { ascending: true });

      if (error) { res.status(500).json({ error: error.message }); return; }
      // Remap title -> name to match the frontend interface, same as the
      // create/update endpoints do. Without this every goal card renders
      // without a title because the UI reads goal.name.
      const remapped = (data || []).map((row) => {
        const r = row as Record<string, unknown>;
        if (r.title !== undefined && r.name === undefined) r.name = r.title;
        return r;
      });
      res.json({ data: remapped });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Create goal
  router.post('/api/goals', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { name, description, target_metric, target_value, current_value, unit, status, priority, due_date, color } = req.body;

      if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const { error } = await db.from('agent_workforce_goals').insert({
        id, workspace_id: workspaceId,
        title: name,
        description: description || null,
        target_metric: target_metric || null,
        target_value: target_value ?? null,
        current_value: current_value ?? 0,
        unit: unit || null,
        status: status || 'active',
        priority: priority || 'normal',
        due_date: due_date || null,
        color: color || '#6366f1',
        created_at: now, updated_at: now,
      });

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('agent_workforce_goals')
        .select('*').eq('id', id).single();

      // Remap title -> name for frontend consistency
      if (created) {
        (created as Record<string, unknown>).name = (created as Record<string, unknown>).title;
      }

      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Update goal
  router.put('/api/goals/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const body = { ...req.body, updated_at: new Date().toISOString() };
      // Remap name -> title for DB
      if (body.name !== undefined) { body.title = body.name; delete body.name; }
      delete body.id; delete body.workspace_id;

      const { error } = await db.from('agent_workforce_goals')
        .update(body)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: updated } = await db.from('agent_workforce_goals')
        .select('*').eq('id', req.params.id).single();

      if (updated) {
        (updated as Record<string, unknown>).name = (updated as Record<string, unknown>).title;
      }

      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delete goal
  router.delete('/api/goals/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { error } = await db.from('agent_workforce_goals')
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
