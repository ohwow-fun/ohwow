/**
 * Trigger API Routes
 *
 * Authenticated REST routes for managing local triggers and viewing webhook events.
 *
 * Triggers:
 *   GET    /api/triggers              — list all triggers
 *   POST   /api/triggers              — create trigger
 *   GET    /api/triggers/action-types — available action types with metadata
 *   GET    /api/triggers/ghl-events   — known GHL event types with sample fields
 *   GET    /api/triggers/:id          — get trigger + recent executions
 *   PUT    /api/triggers/:id          — update trigger
 *   DELETE /api/triggers/:id          — delete trigger
 *
 * Webhook events:
 *   GET    /api/webhook-events        — list recent webhook events (audit)
 *   GET    /api/webhook-events/:id    — inspect single webhook event payload
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { LocalTriggerEvaluator } from '../../triggers/local-trigger-evaluator.js';
import { LocalTriggerService } from '../../triggers/local-trigger-service.js';
import { logger } from '../../lib/logger.js';
import { ACTION_TYPES, GHL_EVENT_TYPES, CONTACT_FIELDS } from '../../triggers/trigger-constants.js';
import { validate } from '../validate.js';
import { createTriggerSchema } from '../schemas/index.js';

export function createTriggersRouter(db: DatabaseAdapter, triggerEvaluator?: LocalTriggerEvaluator, onScheduleChange?: () => void): Router {
  const router = Router();
  const service = new LocalTriggerService(db);

  // List all triggers
  router.get('/api/triggers', async (_req, res) => {
    try {
      const triggers = await service.list();
      res.json({ data: triggers });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Available action types with metadata
  router.get('/api/triggers/action-types', (_req, res) => {
    res.json({
      data: ACTION_TYPES,
      contactFields: CONTACT_FIELDS,
    });
  });

  // Known GHL event types with sample fields
  router.get('/api/triggers/ghl-events', (_req, res) => {
    res.json({ data: GHL_EVENT_TYPES });
  });

  // Create trigger
  router.post('/api/triggers', validate(createTriggerSchema), async (req, res) => {
    try {
      const { name, description, source, event_type, conditions, action_type, action_config, cooldown_seconds, actions, trigger_type, trigger_config, variables, sample_payload, sample_fields, node_positions } = req.body;

      const trigger = await service.create({
        name,
        description,
        source,
        event_type,
        conditions,
        action_type,
        action_config,
        cooldown_seconds,
        actions,
        trigger_type,
        trigger_config,
        variables,
        sample_payload,
        sample_fields,
        node_positions,
      });

      onScheduleChange?.();
      res.status(201).json({ data: trigger });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get sample data for a trigger (used by field mapping UI)
  router.get('/api/triggers/:id/sample', async (req, res) => {
    try {
      const result = await service.getSampleData(req.params.id);
      res.json({ data: result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get webhook URL for a custom trigger
  router.get('/api/triggers/:id/webhook-url', async (req, res) => {
    try {
      const trigger = await service.getById(req.params.id);
      if (!trigger) {
        res.status(404).json({ error: 'Trigger not found' });
        return;
      }
      if (!trigger.webhook_token) {
        res.status(400).json({ error: 'This trigger does not have a webhook URL' });
        return;
      }

      // Prefer cloud webhook proxy URL (permanent, no tunnel needed)
      const { data: cloudWsSetting } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'cloud_workspace_id')
        .maybeSingle();

      if (cloudWsSetting) {
        const cloudWorkspaceId = (cloudWsSetting as { value: string }).value;

        // Read cloud URL from runtime_settings (set during connect)
        const { data: cloudUrlSetting } = await db.from('runtime_settings')
          .select('value')
          .eq('key', 'cloud_url')
          .maybeSingle();

        const cloudUrl = cloudUrlSetting
          ? (cloudUrlSetting as { value: string }).value
          : 'https://www.ohwow.fun';

        const baseUrl = cloudUrl;
        res.json({
          data: {
            webhookUrl: `${baseUrl}/hooks/${cloudWorkspaceId}/${trigger.webhook_token}`,
            webhookToken: trigger.webhook_token,
            baseUrl,
          },
        });
        return;
      }

      // Fallback: tunnel URL or localhost
      const { data: tunnelSetting } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'tunnel_url')
        .maybeSingle();

      const baseUrl = tunnelSetting
        ? (tunnelSetting as { value: string }).value
        : `${req.protocol}://${req.get('host')}`;

      res.json({
        data: {
          webhookUrl: `${baseUrl}/webhooks/incoming/${trigger.webhook_token}`,
          webhookToken: trigger.webhook_token,
          baseUrl,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get trigger with recent executions
  router.get('/api/triggers/:id', async (req, res) => {
    try {
      const trigger = await service.getById(req.params.id);
      if (!trigger) {
        res.status(404).json({ error: 'Trigger not found' });
        return;
      }

      const executions = await service.getExecutions(req.params.id, 20);
      res.json({ data: { ...trigger, executions } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Update trigger (accept both PUT and PATCH — dashboard uses PATCH)
  const handleUpdateTrigger: import('express').RequestHandler<{ id: string }> = async (req, res) => {
    try {
      const trigger = await service.update(req.params.id, req.body);
      if (!trigger) {
        res.status(404).json({ error: 'Trigger not found' });
        return;
      }
      onScheduleChange?.();
      res.json({ data: trigger });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  };
  router.put('/api/triggers/:id', handleUpdateTrigger);
  router.patch('/api/triggers/:id', handleUpdateTrigger);

  // Execute trigger manually
  router.post('/api/triggers/:id/execute', async (req, res) => {
    try {
      if (!triggerEvaluator) {
        res.status(503).json({ error: 'Trigger evaluator not available' });
        return;
      }

      const trigger = await service.getById(req.params.id);
      if (!trigger) {
        res.status(404).json({ error: 'Trigger not found' });
        return;
      }

      const data = (req.body?.data as Record<string, unknown>) || {};

      // Fire-and-forget — respond immediately, execution happens async
      triggerEvaluator.executeById(trigger.id, data).catch((err) => {
        logger.error({ err }, '[TriggersAPI] Execute error for %s', trigger.id);
      });

      res.json({ data: { triggered: true, trigger_id: trigger.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delete trigger
  router.delete('/api/triggers/:id', async (req, res) => {
    try {
      await service.delete(req.params.id);
      onScheduleChange?.();
      res.json({ data: { deleted: true } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // List recent webhook events
  router.get('/api/webhook-events', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      const { data } = await db.from('webhook_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get single webhook event
  router.get('/api/webhook-events/:id', async (req, res) => {
    try {
      const { data } = await db.from('webhook_events')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();

      if (!data) {
        res.status(404).json({ error: 'Webhook event not found' });
        return;
      }

      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
