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

  // List projects with per-project task rollups so the UI doesn't have to
  // fan-out to /api/tasks per card.
  router.get('/api/projects', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_projects')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });

      if (error) { res.status(500).json({ error: error.message }); return; }

      // Rollup: task counts + open-task count per project. A single scan of
      // agent_workforce_tasks filtered by workspace + project_id not null.
      const rollups = new Map<string, { total: number; open: number }>();
      try {
        const { data: taskRows } = await db.from('agent_workforce_tasks')
          .select('project_id,status')
          .eq('workspace_id', workspaceId);
        for (const row of (taskRows as Array<{ project_id: string | null; status: string }> | null) ?? []) {
          if (!row.project_id) continue;
          const r = rollups.get(row.project_id) ?? { total: 0, open: 0 };
          r.total += 1;
          if (row.status !== 'completed' && row.status !== 'approved' && row.status !== 'failed' && row.status !== 'rejected') {
            r.open += 1;
          }
          rollups.set(row.project_id, r);
        }
      } catch {
        // best-effort; cards still render with undefined task counts
      }

      const enriched = (data ?? []).map((p: Record<string, unknown>) => {
        const r = rollups.get(p.id as string) ?? { total: 0, open: 0 };
        return { ...p, task_count: r.total, open_task_count: r.open };
      });

      res.json({ data: enriched });
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
