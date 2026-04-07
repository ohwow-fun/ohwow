/**
 * Deliverables Routes
 * GET /api/tasks/:id/deliverables — Get deliverables for a task
 * GET /api/deliverables — List all deliverables (workspace-scoped)
 * PATCH /api/deliverables/:id — Update a deliverable (approve/reject)
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

export function createDeliverablesRouter(db: DatabaseAdapter): Router {
  const router = Router();

  // Get deliverables for a specific task
  router.get('/api/tasks/:id/deliverables', async (req, res) => {
    try {
      const { workspaceId } = req;

      // Verify task belongs to workspace
      const { data: task } = await db.from('agent_workforce_tasks')
        .select('id')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .single();

      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const { data, error } = await db.from('agent_workforce_deliverables')
        .select('*')
        .eq('task_id', req.params.id)
        .order('created_at', { ascending: false });

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // List all deliverables for workspace
  router.get('/api/deliverables', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { status, type, limit = '50' } = req.query;

      const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 50, 1), 200);

      let query = db.from('agent_workforce_deliverables')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(parsedLimit);

      if (status) query = query.eq('status', status as string);
      if (type) query = query.eq('deliverable_type', type as string);

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

  // Update deliverable (approve/reject)
  router.patch('/api/deliverables/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { status, rejectionReason } = req.body as {
        status?: string;
        rejectionReason?: string;
      };

      if (!status || !['approved', 'rejected'].includes(status)) {
        res.status(400).json({ error: 'status must be "approved" or "rejected"' });
        return;
      }

      const updateData: Record<string, unknown> = {
        status,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (status === 'rejected' && rejectionReason) {
        updateData.rejection_reason = rejectionReason;
      }

      const { data, error } = await db.from('agent_workforce_deliverables')
        .update(updateData)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .select('*')
        .single();

      if (error || !data) {
        res.status(404).json({ error: 'Deliverable not found' });
        return;
      }

      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
