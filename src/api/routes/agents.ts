/**
 * Agents Routes
 * GET /api/agents — List local agents
 * POST /api/agents — Create a new agent
 * GET /api/agents/:id — Get single agent
 * PATCH /api/agents/:id — Update agent fields
 * DELETE /api/agents/:id — Delete an agent
 * GET /api/agents/:id/budget-status — Get agent budget status and spend
 * GET /api/agents/:id/memory — Get agent memory
 */

import { Router } from 'express';
import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { validate } from '../validate.js';
import { createAgentSchema } from '../schemas/index.js';
import { DEFAULT_AGENT_TOOLS } from '../../tui/data/agent-presets.js';

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
      const { name, role, system_prompt, description, department_id, config: userConfig } = req.body;

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const { error } = await db.from('agent_workforce_agents').insert({
        id,
        workspace_id: workspaceId,
        department_id: department_id || null,
        name,
        role,
        system_prompt,
        description: description || null,
        status: 'idle',
        config: JSON.stringify({
          model: userConfig?.model || 'qwen3:0.6b',
          temperature: userConfig?.temperature ?? 0.7,
          max_tokens: userConfig?.max_tokens ?? 4096,
          tools_enabled: [...new Set([...DEFAULT_AGENT_TOOLS, ...(userConfig?.tools_enabled || [])])],
          approval_required: userConfig?.approval_required ?? false,
          web_search_enabled: userConfig?.web_search_enabled ?? true,
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
      const allowedFields = ['voice_profile_id', 'status', 'autonomy_budget'];
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

  // Get agent budget status
  router.get('/api/agents/:id/budget-status', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data: agent, error } = await db.from('agent_workforce_agents')
        .select('autonomy_budget')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .single();

      if (error || !agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      // Parse budget
      const raw = (agent as Record<string, unknown>).autonomy_budget as string | null;
      let budget: { perTaskCents: number; dailyCents: number; monthlyCents: number; warnAt: number } | null = null;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          budget = {
            perTaskCents: parsed.perTaskCents || 0,
            dailyCents: parsed.dailyCents || 0,
            monthlyCents: parsed.monthlyCents || 0,
            warnAt: parsed.warnAt ?? 0.8,
          };
        } catch { /* invalid JSON, treat as no budget */ }
      }

      // Query today's spend
      const today = new Date().toISOString().slice(0, 10);
      const { data: todayRow } = await db
        .from('resource_usage_daily')
        .select('total_cost_cents')
        .eq('workspace_id', workspaceId)
        .eq('date', today)
        .maybeSingle();

      const dailySpent = (todayRow as { total_cost_cents: number } | null)?.total_cost_cents ?? 0;

      // Query current month spend
      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const monthEnd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-31`;

      const { data: monthRows } = await db
        .from('resource_usage_daily')
        .select('total_cost_cents')
        .eq('workspace_id', workspaceId)
        .gte('date', monthStart)
        .lte('date', monthEnd);

      const monthlySpent = (monthRows as Array<{ total_cost_cents: number }> | null)
        ?.reduce((sum, row) => sum + (row.total_cost_cents || 0), 0) ?? 0;

      res.json({ data: { dailySpent, monthlySpent, budget } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
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
