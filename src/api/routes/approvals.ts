/**
 * Approvals Routes
 * GET /api/approvals — List tasks needing approval
 * GET /api/approvals/:id/preview — Dry-inspect what an approval will fire
 * POST /api/approvals/:id/approve — Approve a task
 * POST /api/approvals/:id/reject — Reject a task
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { DeliverableExecutor } from '../../execution/deliverable-executor.js';

export function createApprovalsRouter(db: DatabaseAdapter): Router {
  const router = Router();
  const executor = new DeliverableExecutor(db);

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

  // Preview what approval will actually fire — task + deliverables +
  // live-mode flag + a one-line verdict. Lets operators check before
  // committing, especially when the task description doesn't reveal
  // whether a deliverable is attached or whether a real DM/tweet will
  // go out.
  router.get('/api/approvals/:id/preview', async (req, res) => {
    try {
      const { workspaceId } = req;

      const { data: task, error: fetchErr } = await db.from('agent_workforce_tasks')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .maybeSingle();

      if (fetchErr || !task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const { data: delivRowsRaw } = await db.from('agent_workforce_deliverables')
        .select('*')
        .eq('task_id', req.params.id)
        .eq('workspace_id', workspaceId);
      const delivRows = (delivRowsRaw as Array<{ id: string }>) ?? [];

      interface PreviewDeliverable {
        id: string;
        deliverable_type: string | null;
        provider: string | null;
        status: string | null;
        title: string | null;
        contentPreview: string;
        actionType: string | null;
        hasHandler: boolean;
        target: { handle: string | null; conversation_pair: string | null } | null;
      }

      const { data: liveSetting } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'deliverable_executor_live')
        .maybeSingle();
      const liveSettingVal = (liveSetting as { value?: string } | null)?.value;
      const liveMode = liveSettingVal === 'true' || liveSettingVal === '1';

      const deliverables: PreviewDeliverable[] = [];
      for (const raw of delivRows) {
        const preview = await executor.preview(raw.id);
        const row = preview.deliverable;
        if (!row) continue;
        const content = preview.content;
        const text = typeof content.text === 'string' ? content.text : '';
        const target = preview.actionType === 'send_dm'
          ? {
              handle: typeof content.handle === 'string' ? content.handle : null,
              conversation_pair: typeof content.conversation_pair === 'string' ? content.conversation_pair : null,
            }
          : null;
        deliverables.push({
          id: row.id,
          deliverable_type: row.deliverable_type ?? null,
          provider: row.provider ?? null,
          status: row.status ?? null,
          title: (row as { title?: string }).title ?? null,
          contentPreview: text.slice(0, 200),
          actionType: preview.actionType,
          hasHandler: preview.hasHandler,
          target,
        });
      }

      const taskRow = task as { status?: string };
      const taskStatus = taskRow.status ?? 'unknown';

      let verdict: string;
      if (taskStatus !== 'needs_approval') {
        verdict = `Task already resolved (status=${taskStatus}). Approval is a no-op.`;
      } else if (deliverables.length === 0) {
        verdict = 'Will mark task approved. No deliverable is attached, so no external action fires.';
      } else {
        const pending = deliverables.filter((d) => d.status === 'pending_review');
        if (pending.length === 0) {
          verdict = `Will mark task approved. Deliverable(s) already in status=${deliverables[0].status} — cascade is a no-op.`;
        } else {
          const parts = pending.map((d) => {
            const short = d.id.slice(0, 8);
            if (!d.actionType) {
              return `deliverable ${short}: no action_spec and no inferrable type, will fail-log "no action_spec or inferrable action type".`;
            }
            if (!d.hasHandler) {
              return `deliverable ${short}: actionType=${d.actionType} has no registered handler, will fail-log.`;
            }
            const who = d.target?.handle
              ? `@${d.target.handle}`
              : d.target?.conversation_pair
                ? `conversation_pair=${d.target.conversation_pair}`
                : null;
            const mode = liveMode
              ? 'LIVE — real send via Playwright'
              : "DRY-RUN — executor live=false (set runtime_settings.deliverable_executor_live='true' to send for real)";
            return `will fire ${d.actionType}${who ? ` to ${who}` : ''} — ${mode}.`;
          });
          verdict = parts.join(' ');
        }
      }

      res.json({ data: { task, deliverables, liveMode, verdict } });
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

      // Run the real-world action (post tweet, send email, etc.) for any
      // deliverable this task produced. Defaults to dry-run unless the
      // workspace has runtime_settings.deliverable_executor_live='true'.
      // Errors don't fail the HTTP response — the approval already landed;
      // execution outcome is captured in deliverables.delivery_result.
      let executionResults: unknown[] = [];
      try {
        executionResults = await executor.executeForTask(req.params.id);
      } catch (err) {
        executionResults = [{ ok: false, error: err instanceof Error ? err.message : String(err) }];
      }

      res.json({ data: { id: req.params.id, status: 'approved', execution: executionResults } });
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
