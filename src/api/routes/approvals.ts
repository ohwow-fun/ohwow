/**
 * Approvals Routes
 * GET /api/approvals — List tasks needing approval
 * POST /api/approvals/:id/approve — Approve a task
 * POST /api/approvals/:id/reject — Reject a task
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

export function createApprovalsRouter(db: DatabaseAdapter): Router {
  const router = Router();

  // List tasks needing approval
  router.get('/api/approvals', async (req, res) => {
    try {
      const { workspaceId } = req;

      const { data, error } = await db.from('agent_workforce_tasks')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('status', 'needs_approval')
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

  // Approve a task
  router.post('/api/approvals/:id/approve', async (req, res) => {
    try {
      const { workspaceId } = req;

      const { data: task, error: fetchErr } = await db.from('agent_workforce_tasks')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .eq('status', 'needs_approval')
        .single();

      if (fetchErr || !task) {
        res.status(404).json({ error: 'Approval not found' });
        return;
      }

      const { error: updateErr } = await db.from('agent_workforce_tasks')
        .update({ status: 'approved', updated_at: new Date().toISOString() })
        .eq('id', req.params.id);

      if (updateErr) {
        res.status(500).json({ error: updateErr.message });
        return;
      }

      res.json({ data: { id: req.params.id, status: 'approved' } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Reject a task
  router.post('/api/approvals/:id/reject', async (req, res) => {
    try {
      const { workspaceId } = req;

      const { data: task, error: fetchErr } = await db.from('agent_workforce_tasks')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .eq('status', 'needs_approval')
        .single();

      if (fetchErr || !task) {
        res.status(404).json({ error: 'Approval not found' });
        return;
      }

      const rejectUpdate: Record<string, unknown> = {
        status: 'rejected',
        updated_at: new Date().toISOString(),
      };
      if (req.body?.reason) {
        rejectUpdate.rejection_reason = req.body.reason;
      }

      const { error: updateErr } = await db.from('agent_workforce_tasks')
        .update(rejectUpdate)
        .eq('id', req.params.id);

      if (updateErr) {
        res.status(500).json({ error: updateErr.message });
        return;
      }

      res.json({ data: { id: req.params.id, status: 'rejected' } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
