/**
 * Projects Routes
 * CRUD for agent_workforce_projects + project tasks.
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

export function createProjectsRouter(db: DatabaseAdapter, _eventBus: TypedEventBus<RuntimeEvents>): Router {
  const router = Router();

  // List projects
  router.get('/api/projects', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_projects')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Create project
  router.post('/api/projects', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { name, description, status, color } = req.body;

      if (!name) { res.status(400).json({ error: 'name is required' }); return; }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const { error } = await db.from('agent_workforce_projects').insert({
        id, workspace_id: workspaceId, name,
        description: description || null,
        status: status || 'active',
        color: color || null,
        created_at: now, updated_at: now,
      });

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('agent_workforce_projects')
        .select('*').eq('id', id).single();

      if (created) {
        _eventBus.emit('project:created', created);
      }

      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Update project
  router.put('/api/projects/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const updates = { ...req.body, updated_at: new Date().toISOString() };
      delete updates.id; delete updates.workspace_id;

      const { error } = await db.from('agent_workforce_projects')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: updated } = await db.from('agent_workforce_projects')
        .select('*').eq('id', req.params.id).single();

      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delete project
  router.delete('/api/projects/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { error } = await db.from('agent_workforce_projects')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get project tasks
  router.get('/api/projects/:id/tasks', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_tasks')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('project_id', req.params.id)
        .order('created_at', { ascending: false });

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
