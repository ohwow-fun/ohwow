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

  async function logActivity(
    workspaceId: string,
    activityType: string,
    title: string,
    description: string | null,
    agentId: string | null,
    taskId: string,
  ): Promise<void> {
    try {
      await db.from('agent_workforce_activity').insert({
        workspace_id: workspaceId,
        activity_type: activityType,
        title,
        description,
        agent_id: agentId,
        task_id: taskId,
        metadata: JSON.stringify({}),
        created_at: new Date().toISOString(),
      });
    } catch {
      // Activity logging is best-effort; don't fail the approval on log errors.
    }
  }

  // Approve a task — also stamps audit columns and cascades to its deliverable.
  router.post('/api/approvals/:id/approve', async (req, res) => {
    try {
      const { workspaceId, userId } = req;

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

      const now = new Date().toISOString();
      const { error: updateErr } = await db.from('agent_workforce_tasks')
        .update({
          status: 'approved',
          approved_at: now,
          approved_by: userId ?? 'local',
          updated_at: now,
        })
        .eq('id', req.params.id);

      if (updateErr) {
        res.status(500).json({ error: updateErr.message });
        return;
      }

      // Cascade: any deliverables attached to this task that are still in
      // pending_review should graduate to approved. Without this, the
      // Deliverables tab kept showing approved tasks' work as pending_review.
      await db.from('agent_workforce_deliverables')
        .update({
          status: 'approved',
          reviewed_at: now,
          reviewed_by: userId ?? 'local',
          updated_at: now,
        })
        .eq('task_id', req.params.id)
        .eq('workspace_id', workspaceId)
        .eq('status', 'pending_review');

      const taskRow = task as { title?: string; agent_id?: string | null };
      await logActivity(
        workspaceId,
        'task_approved',
        taskRow.title ?? 'Task approved',
        `Approved by ${userId ?? 'local'}`,
        taskRow.agent_id ?? null,
        req.params.id,
      );

      res.json({ data: { id: req.params.id, status: 'approved' } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Reject a task — cascades to deliverable, stamps audit fields.
  router.post('/api/approvals/:id/reject', async (req, res) => {
    try {
      const { workspaceId, userId } = req;

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

      const now = new Date().toISOString();
      const reason: string | undefined = req.body?.reason;

      const rejectUpdate: Record<string, unknown> = {
        status: 'rejected',
        approved_by: userId ?? 'local',
        approved_at: now,
        updated_at: now,
      };
      if (reason) rejectUpdate.rejection_reason = reason;

      const { error: updateErr } = await db.from('agent_workforce_tasks')
        .update(rejectUpdate)
        .eq('id', req.params.id);

      if (updateErr) {
        res.status(500).json({ error: updateErr.message });
        return;
      }

      await db.from('agent_workforce_deliverables')
        .update({
          status: 'rejected',
          reviewed_at: now,
          reviewed_by: userId ?? 'local',
          rejection_reason: reason ?? null,
          updated_at: now,
        })
        .eq('task_id', req.params.id)
        .eq('workspace_id', workspaceId)
        .eq('status', 'pending_review');

      const taskRow = task as { title?: string; agent_id?: string | null };
      await logActivity(
        workspaceId,
        'task_rejected',
        taskRow.title ?? 'Task rejected',
        reason ? `Rejected by ${userId ?? 'local'}: ${reason}` : `Rejected by ${userId ?? 'local'}`,
        taskRow.agent_id ?? null,
        req.params.id,
      );

      res.json({ data: { id: req.params.id, status: 'rejected' } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
