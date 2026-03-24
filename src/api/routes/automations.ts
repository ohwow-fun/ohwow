/**
 * Automations API Routes (Unified Schema)
 *
 * Mirrors the cloud /api/automations endpoints exactly so the dashboard
 * can use the same request/response shapes in local mode.
 *
 *   GET    /api/automations              — list all automations
 *   POST   /api/automations              — create automation
 *   GET    /api/automations/:id          — get automation + runs
 *   PATCH  /api/automations/:id          — update automation
 *   DELETE /api/automations/:id          — soft delete (archive)
 *   POST   /api/automations/:id/execute  — execute automation
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { LocalTriggerEvaluator } from '../../triggers/local-trigger-evaluator.js';
import { AutomationService } from '../../triggers/automation-service.js';
import { logger } from '../../lib/logger.js';
import { LocalTriggerService } from '../../triggers/local-trigger-service.js';
import { validate } from '../validate.js';
import { createAutomationSchema } from '../schemas/index.js';

export function createAutomationsRouter(
  db: DatabaseAdapter,
  workspaceId: string,
  triggerEvaluator?: LocalTriggerEvaluator,
  onScheduleChange?: () => void,
): Router {
  const router = Router();
  const service = new AutomationService(db, workspaceId);
  const triggerService = new LocalTriggerService(db);

  // List all automations
  router.get('/api/automations', async (_req, res) => {
    try {
      const automations = await service.list();
      res.json({ automations });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Create automation
  router.post('/api/automations', validate(createAutomationSchema), async (req, res) => {
    try {
      const automation = await service.create(req.body);
      onScheduleChange?.();
      res.status(201).json({ automation });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get automation with recent runs
  router.get('/api/automations/:id', async (req, res) => {
    try {
      const automation = await service.getById(req.params.id);
      if (!automation) {
        res.status(404).json({ error: 'Automation not found' });
        return;
      }

      const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
      const executions = await triggerService.getExecutions(req.params.id, limit);

      // Map executions to runs format matching cloud API
      const runs = executions.map((exec) => ({
        id: exec.id,
        automation_id: exec.trigger_id,
        workspace_id: '',
        status: exec.status === 'dispatched' ? 'completed' : exec.status,
        current_step_index: exec.step_index ?? 0,
        total_steps: 1,
        step_results: [],
        started_at: exec.created_at,
        completed_at: exec.created_at,
        error_message: exec.error_message,
        failed_step_index: exec.status === 'failed' ? (exec.step_index ?? 0) : null,
        created_at: exec.created_at,
      }));

      res.json({
        automation,
        runs,
        totalRuns: runs.length,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Update automation
  router.patch('/api/automations/:id', async (req, res) => {
    try {
      const automation = await service.update(req.params.id, req.body);
      if (!automation) {
        res.status(404).json({ error: 'Automation not found' });
        return;
      }
      onScheduleChange?.();
      res.json({ automation });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Also accept PUT for backward compat
  router.put('/api/automations/:id', async (req, res) => {
    try {
      const automation = await service.update(req.params.id, req.body);
      if (!automation) {
        res.status(404).json({ error: 'Automation not found' });
        return;
      }
      onScheduleChange?.();
      res.json({ automation });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Soft delete (archive)
  router.delete('/api/automations/:id', async (req, res) => {
    try {
      await service.delete(req.params.id);
      onScheduleChange?.();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Execute automation
  router.post('/api/automations/:id/execute', async (req, res) => {
    try {
      if (!triggerEvaluator) {
        res.status(503).json({ error: 'Trigger evaluator not available' });
        return;
      }

      const automation = await service.getById(req.params.id);
      if (!automation) {
        res.status(404).json({ error: 'Automation not found' });
        return;
      }

      const data = (req.body?.data as Record<string, unknown>) || {};

      // Fire-and-forget
      triggerEvaluator.executeById(automation.id, data).catch((err) => {
        logger.error({ err }, '[AutomationsAPI] Execute error for %s', automation.id);
      });

      res.json({ data: { triggered: true } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
