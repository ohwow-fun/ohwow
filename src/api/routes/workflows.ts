/**
 * Workflows Routes
 * CRUD for agent_workforce_workflows + AI generation.
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ModelRouter } from '../../execution/model-router.js';
import { logger } from '../../lib/logger.js';
import { buildWorkflowGeneratorPrompt } from '../../lib/workflow-generator-prompt.js';
import type { IntegrationSummary } from '../../lib/workflow-generator-prompt.js';
import { validate } from '../validate.js';
import { createWorkflowSchema, generateWorkflowSchema } from '../schemas/index.js';

export function createWorkflowsRouter(db: DatabaseAdapter, modelRouter?: ModelRouter): Router {
  const router = Router();

  // Generate workflow via AI (must be before /:id routes)
  router.post('/api/workflows/generate', validate(generateWorkflowSchema), async (req, res) => {
    try {
      if (!modelRouter) {
        res.status(503).json({ error: 'AI generation is not available. No model provider configured.' });
        return;
      }

      const { workspaceId } = req;
      const { description } = req.body as { description: string };

      // Load active agents
      const { data: agents, error: agentsErr } = await db.from('agent_workforce_agents')
        .select('id, name, role, department')
        .eq('workspace_id', workspaceId)
        .neq('status', 'paused');

      if (agentsErr) {
        res.status(500).json({ error: agentsErr.message });
        return;
      }

      if (!agents || agents.length === 0) {
        res.status(400).json({ error: 'No active agents found. Add agents first.' });
        return;
      }

      const agentSummaries = (agents as Array<{ id: string; name: string; role: string; department?: string }>).map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        department: a.department,
      }));

      // Load integrations
      const { data: integrations } = await db.from('agent_workforce_integrations')
        .select('provider, status')
        .eq('workspace_id', workspaceId);

      const integrationSummaries: IntegrationSummary[] = integrations
        ? (integrations as Array<{ provider: string; status: string }>).map((i) => ({
            provider: i.provider,
            name: i.provider,
            connected: i.status === 'active',
          }))
        : [];

      const prompt = buildWorkflowGeneratorPrompt(agentSummaries, description, integrationSummaries);

      const provider = await modelRouter.getProvider('planning');
      const result = await provider.createMessage({
        system: 'You are a workflow architect. Always respond with valid JSON only, no markdown code blocks.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1500,
        temperature: 0.5,
      });

      // Parse JSON from response
      const cleaned = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const workflow = JSON.parse(cleaned);
      res.json({ workflow });
    } catch (err) {
      logger.error({ err }, '[Workflows] Generate error');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Couldn\'t generate workflow. Try again?' });
    }
  });

  // List workflows
  router.get('/api/workflows', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_workflows')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ workflows: data || [], triggerCounts: {} });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get single workflow
  router.get('/api/workflows/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_workflows')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .maybeSingle();

      if (error) { res.status(500).json({ error: error.message }); return; }
      if (!data) { res.status(404).json({ error: 'Workflow not found' }); return; }
      res.json({ workflow: data, runs: [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Create workflow
  router.post('/api/workflows', validate(createWorkflowSchema), async (req, res) => {
    try {
      const { workspaceId } = req;
      const { name, description, definition } = req.body as {
        name: string;
        description?: string;
        definition?: unknown;
      };

      const now = new Date().toISOString();
      const id = crypto.randomUUID();

      const { error } = await db.from('agent_workforce_workflows')
        .insert({
          id,
          workspace_id: workspaceId,
          name: name.trim(),
          description: description?.trim() || null,
          definition: definition ? JSON.stringify(definition) : '{}',
          status: 'draft',
          created_at: now,
          updated_at: now,
        });

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.status(201).json({ workflow: { id, name: name.trim(), status: 'draft' } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Update workflow (status, name, description, definition)
  router.patch('/api/workflows/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { name, description, definition, status } = req.body as {
        name?: string;
        description?: string;
        definition?: unknown;
        status?: string;
      };

      // Verify ownership
      const { data: existing, error: fetchErr } = await db.from('agent_workforce_workflows')
        .select('id')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .maybeSingle();

      if (fetchErr || !existing) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (name !== undefined) updates.name = name.trim();
      if (description !== undefined) updates.description = description?.trim() || null;
      if (definition !== undefined) updates.definition = JSON.stringify(definition);
      if (status !== undefined) {
        const validStatuses = ['draft', 'active', 'paused', 'archived'];
        if (!validStatuses.includes(status)) {
          res.status(400).json({ error: `Status must be one of: ${validStatuses.join(', ')}` });
          return;
        }
        updates.status = status;
      }

      const { error: updateErr } = await db.from('agent_workforce_workflows')
        .update(updates)
        .eq('id', req.params.id);

      if (updateErr) {
        res.status(500).json({ error: updateErr.message });
        return;
      }

      res.json({ workflow: { id: req.params.id, ...updates } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delete workflow
  router.delete('/api/workflows/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { error } = await db.from('agent_workforce_workflows')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
