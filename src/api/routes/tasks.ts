/**
 * Tasks Routes
 * GET /api/tasks — List tasks
 * GET /api/tasks/:id — Get task details
 * GET /api/tasks/:id/messages — Get task conversation
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { RuntimeEngine } from '../../execution/engine.js';

export function createTasksRouter(db: DatabaseAdapter, engine?: RuntimeEngine | null): Router {
  const router = Router();

  // List tasks (with optional filters)
  router.get('/api/tasks', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { agentId, status, limit = '50' } = req.query;

      let query = db.from('agent_workforce_tasks')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(parseInt(limit as string, 10));

      if (agentId) {
        query = query.eq('agent_id', agentId as string);
      }
      if (status) {
        query = query.eq('status', status as string);
      }

      const { data, error } = await query;

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get single task
  router.get('/api/tasks/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_tasks')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .single();

      if (error || !data) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Dispatch a new task
  router.post('/api/tasks', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { agentId, title, description } = req.body as {
        agentId?: string;
        title?: string;
        description?: string;
      };

      if (!agentId || !title) {
        res.status(400).json({ error: 'agentId and title are required' });
        return;
      }

      const taskId = crypto.randomUUID();
      const now = new Date().toISOString();

      const { error: insertErr } = await db.from('agent_workforce_tasks').insert({
        id: taskId,
        agent_id: agentId,
        workspace_id: workspaceId,
        title,
        description: description || null,
        input: JSON.stringify({ title, description }),
        status: 'queued',
        priority: 'normal',
        created_at: now,
        updated_at: now,
      });

      if (insertErr) {
        res.status(500).json({ error: insertErr.message });
        return;
      }

      // Execute async if engine is available
      if (engine) {
        engine.executeTask(agentId, taskId).catch(() => {});
      }

      res.status(201).json({ data: { id: taskId, status: 'queued' } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Execute an existing task
  router.post('/api/tasks/:id/execute', async (req, res) => {
    try {
      if (!engine) {
        res.status(503).json({ error: 'Engine not available' });
        return;
      }

      const { workspaceId } = req;
      const { data: task, error: fetchErr } = await db.from('agent_workforce_tasks')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .single();

      if (fetchErr || !task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const row = task as Record<string, unknown>;
      const agentId = row.agent_id as string;

      // Fire-and-forget execution
      engine.executeTask(agentId, req.params.id).catch(() => {});
      res.status(202).json({ data: { id: req.params.id, status: 'executing' } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get task messages
  router.get('/api/tasks/:id/messages', async (req, res) => {
    try {
      const { data, error } = await db.from('agent_workforce_task_messages')
        .select('*')
        .eq('task_id', req.params.id)
        .order('created_at', { ascending: true });

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
