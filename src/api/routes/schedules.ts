/**
 * Schedules Routes
 * GET /api/schedules — List schedules
 * POST /api/schedules — Create schedule
 * PUT /api/schedules/:id — Update schedule
 * DELETE /api/schedules/:id — Delete schedule
 * POST /api/schedules/:id/toggle — Toggle schedule enabled/disabled
 */

import { Router, type Request } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { WorkspaceContext } from '../../daemon/workspace-context.js';

export function createSchedulesRouter(
  db: DatabaseAdapter,
  onScheduleChange?: () => void,
  getWorkspaceCtx?: (req: Request) => WorkspaceContext | null,
): Router {
  const router = Router();
  const resolveDb = (req: Request) => (getWorkspaceCtx?.(req)?.db) ?? db;

  // List schedules
  router.get('/api/schedules', async (req, res) => {
    try {
      const activeDb = resolveDb(req);
      const { workspaceId } = req;

      const { data, error } = await activeDb.from('agent_workforce_schedules')
        .select('*')
        .eq('workspace_id', workspaceId)
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

  // Create schedule
  router.post('/api/schedules', async (req, res) => {
    try {
      const activeDb = resolveDb(req);
      const { workspaceId } = req;
      const { label, agent_id, cron, task_prompt, description } = req.body as {
        label?: string;
        agent_id?: string;
        cron?: string;
        task_prompt?: string;
        description?: string;
      };

      if (!label?.trim()) {
        res.status(400).json({ error: 'Label is required' });
        return;
      }
      if (!cron?.trim()) {
        res.status(400).json({ error: 'Cron expression is required' });
        return;
      }

      const now = new Date().toISOString();
      const id = crypto.randomUUID();

      const { error } = await activeDb.from('agent_workforce_schedules')
        .insert({
          id,
          workspace_id: workspaceId,
          label: label.trim(),
          agent_id: agent_id || null,
          cron: cron.trim(),
          cron_expression: cron.trim(),
          task_prompt: task_prompt || description || '',
          enabled: 1,
          created_at: now,
          updated_at: now,
        });

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      onScheduleChange?.();
      res.json({ schedule: { id, label: label.trim(), cron: cron.trim(), enabled: true } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Update schedule
  router.put('/api/schedules/:id', async (req, res) => {
    try {
      const activeDb = resolveDb(req);
      const { workspaceId } = req;
      const { label, agent_id, cron, task_prompt, enabled } = req.body as {
        label?: string;
        agent_id?: string;
        cron?: string;
        task_prompt?: string;
        enabled?: boolean;
      };

      // Verify ownership
      const { data: existing, error: fetchErr } = await activeDb.from('agent_workforce_schedules')
        .select('id')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .maybeSingle();

      if (fetchErr || !existing) {
        res.status(404).json({ error: 'Schedule not found' });
        return;
      }

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (label !== undefined) updates.label = label.trim();
      if (agent_id !== undefined) updates.agent_id = agent_id || null;
      if (cron !== undefined) {
        updates.cron = cron.trim();
        updates.cron_expression = cron.trim();
      }
      if (task_prompt !== undefined) updates.task_prompt = task_prompt;
      if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;

      const { error: updateErr } = await activeDb.from('agent_workforce_schedules')
        .update(updates)
        .eq('id', req.params.id);

      if (updateErr) {
        res.status(500).json({ error: updateErr.message });
        return;
      }

      onScheduleChange?.();
      res.json({ data: { id: req.params.id, ...updates } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delete schedule
  router.delete('/api/schedules/:id', async (req, res) => {
    try {
      const activeDb = resolveDb(req);
      const { workspaceId } = req;

      const { error } = await activeDb.from('agent_workforce_schedules')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      onScheduleChange?.();
      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Toggle schedule enabled/disabled
  router.post('/api/schedules/:id/toggle', async (req, res) => {
    try {
      const activeDb = resolveDb(req);
      const { workspaceId } = req;

      const { data: schedule, error: fetchErr } = await activeDb.from('agent_workforce_schedules')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .single();

      if (fetchErr || !schedule) {
        res.status(404).json({ error: 'Schedule not found' });
        return;
      }

      const row = schedule as Record<string, unknown>;
      const newEnabled = row.enabled ? 0 : 1;

      const { error: updateErr } = await activeDb.from('agent_workforce_schedules')
        .update({ enabled: newEnabled, updated_at: new Date().toISOString() })
        .eq('id', req.params.id);

      if (updateErr) {
        res.status(500).json({ error: updateErr.message });
        return;
      }

      onScheduleChange?.();
      res.json({ data: { id: req.params.id, enabled: !!newEnabled } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
