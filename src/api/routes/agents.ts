/**
 * Agents Routes
 * GET /api/agents — List local agents
 * POST /api/agents — Create a new agent
 * GET /api/agents/:id — Get single agent
 * PATCH /api/agents/:id — Update agent fields
 * DELETE /api/agents/:id — Delete an agent
 * GET /api/agents/:id/memory — Get agent memory
 */

import { Router } from 'express';
import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { validate } from '../validate.js';
import { createAgentSchema } from '../schemas/index.js';

export function createAgentsRouter(db: DatabaseAdapter): Router {
  const router = Router();

  // List agents
  router.get('/api/agents', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_agents')
        .select('*')
        .eq('workspace_id', workspaceId);

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Create agent
  router.post('/api/agents', validate(createAgentSchema), async (req, res) => {
    try {
      const { workspaceId } = req;
      const { name, role, system_prompt, description } = req.body;

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const { error } = await db.from('agent_workforce_agents').insert({
        id,
        workspace_id: workspaceId,
        name,
        role,
        system_prompt,
        description: description || null,
        status: 'idle',
        config: JSON.stringify({
          model: 'llama3.1',
          temperature: 0.7,
          max_tokens: 4096,
          approval_required: false,
          web_search_enabled: false,
        }),
        stats: JSON.stringify({
          total_tasks: 0,
          completed_tasks: 0,
          failed_tasks: 0,
          tokens_used: 0,
          cost_cents: 0,
        }),
        created_at: now,
        updated_at: now,
      });

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      const { data } = await db.from('agent_workforce_agents')
        .select('*')
        .eq('id', id)
        .single();

      res.status(201).json({ data });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get single agent
  router.get('/api/agents/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_agents')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .single();

      if (error || !data) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Update agent fields
  router.patch('/api/agents/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const allowedFields = ['voice_profile_id', 'status'];
      const updates: Record<string, unknown> = {};

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }

      // Handle config updates (merge into existing config)
      if (req.body.config !== undefined && typeof req.body.config === 'object') {
        const { data: existing } = await db.from('agent_workforce_agents')
          .select('config')
          .eq('id', req.params.id)
          .eq('workspace_id', workspaceId)
          .single();

        const existingConfig = existing
          ? (typeof existing.config === 'string' ? JSON.parse(existing.config) : (existing.config || {}))
          : {};
        updates.config = JSON.stringify({ ...existingConfig, ...req.body.config });
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'No valid fields to update' });
        return;
      }

      updates.updated_at = new Date().toISOString();

      const { error } = await db.from('agent_workforce_agents')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      // Return updated agent
      const { data } = await db.from('agent_workforce_agents')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .single();

      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delete agent
  router.delete('/api/agents/:id', async (req, res) => {
    try {
      const { workspaceId } = req;

      // Verify agent exists and belongs to workspace
      const { data: existing } = await db.from('agent_workforce_agents')
        .select('id')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .single();

      if (!existing) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      // Delete agent memory
      await db.from('agent_workforce_agent_memory')
        .delete()
        .eq('agent_id', req.params.id);

      // Delete the agent
      const { error } = await db.from('agent_workforce_agents')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ data: { deleted: true } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Trigger memory maintenance for an agent
  router.post('/api/agents/:id/maintenance', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data: agent } = await db.from('agent_workforce_agents')
        .select('id')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .single();

      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      const { runAgentMemoryMaintenance } = await import('../../lib/memory-maintenance.js');
      const result = await runAgentMemoryMaintenance(db, workspaceId, { agentId: req.params.id });
      res.json({ data: result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Maintenance failed' });
    }
  });

  // Get agent memory
  router.get('/api/agents/:id/memory', async (req, res) => {
    try {
      const { data, error } = await db.from('agent_workforce_agent_memory')
        .select('*')
        .eq('agent_id', req.params.id)
        .eq('is_active', 1)
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

  return router;
}
