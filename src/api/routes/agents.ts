/**
 * Agents Routes
 * GET /api/agents — List local agents
 * POST /api/agents — Create a new agent
 * GET /api/agents/:id — Get single agent
 * PATCH /api/agents/:id — Update agent fields
 * DELETE /api/agents/:id — Delete an agent
 * GET /api/agents/:id/budget-status — Get agent budget status and spend
 * GET /api/agents/:id/memory — Get agent memory
 *
 * Name-based lookups are resolved client-side (list → match by name) rather
 * than exposed as their own routes, so the MCP agent-management tools in
 * src/mcp-server/tools/agents.ts can target existing by-id endpoints.
 */

import { Router, type Request } from 'express';
import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { WorkspaceContext } from '../../daemon/workspace-context.js';
import { validate } from '../validate.js';
import { createAgentSchema } from '../schemas/index.js';
import { DEFAULT_AGENT_TOOLS } from '../../tui/data/agent-presets.js';
import { getStaticToolNames } from '../../orchestrator/tools/registry.js';

/** Name: alphanumeric, dashes, underscores. Matches the `name` constraint in
 *  the MCP create-agent tool. Used as a workspace-unique identifier. */
const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate an agent tool allowlist against the known workspace tool surface.
 * Rejects names that are neither in the static orchestrator registry nor
 * look like an external MCP-server tool (the `mcp__<server>__<tool>` shape
 * used by the MCP client registry and the openclaw skill loader). External
 * MCP tool names cannot be strictly validated at create time — they depend
 * on whichever servers are registered in the workspace at invocation time —
 * so we accept the pattern and let the actual invocation fail loudly if the
 * server is missing. Returns the list of syntactically-invalid or unknown
 * internal names, or an empty array if everything passes.
 */
function validateToolAllowlist(names: string[]): string[] {
  const known = new Set(getStaticToolNames());
  const unknown: string[] = [];
  for (const name of names) {
    if (typeof name !== 'string' || name.trim() === '') {
      unknown.push(String(name));
      continue;
    }
    // External MCP server tools: trusted shape, cannot be statically checked.
    if (name.startsWith('mcp__') || name.includes('__')) continue;
    if (!known.has(name)) unknown.push(name);
  }
  return unknown;
}

export function createAgentsRouter(
  db: DatabaseAdapter,
  getWorkspaceCtx?: (req: Request) => WorkspaceContext | null,
): Router {
  const router = Router();
  const resolveDb = (req: Request) => (getWorkspaceCtx?.(req)?.db) ?? db;

  // List agents
  router.get('/api/agents', async (req, res) => {
    try {
      const activeDb = resolveDb(req);
      const { workspaceId } = req;
      const { data, error } = await activeDb.from('agent_workforce_agents')
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
      const activeDb = resolveDb(req);
      const { workspaceId } = req;
      const {
        name,
        role,
        system_prompt,
        description,
        department_id,
        display_name,
        enabled,
        scheduled,
        config: userConfig,
      } = req.body;

      if (!AGENT_NAME_RE.test(name)) {
        res.status(400).json({
          error: 'name must be alphanumeric with dashes or underscores (no spaces)',
        });
        return;
      }

      // Enforce workspace-unique name. The table has no unique index on
      // (workspace_id, name), so the check is race-prone under heavy
      // concurrent writes — acceptable here because agent creation is a
      // single-operator action via the MCP tool or TUI.
      const { data: existing } = await activeDb.from('agent_workforce_agents')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('name', name)
        .maybeSingle();
      if (existing) {
        res.status(409).json({
          error: `An agent named "${name}" already exists in this workspace. Pick a different name, or update the existing one.`,
        });
        return;
      }

      const allowlist = userConfig?.tools_enabled;
      if (allowlist && allowlist.length > 0) {
        const unknown = validateToolAllowlist(allowlist);
        if (unknown.length > 0) {
          res.status(400).json({
            error: `Unknown tool name(s) in allowlist: ${unknown.join(', ')}. Use the exact internal name (see toolRegistry) or an "mcp__<server>__<tool>" identifier.`,
          });
          return;
        }
      }

      const toolsMode = userConfig?.tools_mode ?? (allowlist ? 'allowlist' : 'inherit');
      const toolsEnabled =
        toolsMode === 'allowlist'
          ? [...(allowlist ?? [])]
          : [...new Set([...DEFAULT_AGENT_TOOLS, ...(allowlist ?? [])])];

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const { error } = await activeDb.from('agent_workforce_agents').insert({
        id,
        workspace_id: workspaceId,
        department_id: department_id || null,
        name,
        role: role || 'assistant',
        system_prompt,
        description: description || null,
        status: enabled === false ? 'disabled' : 'idle',
        config: JSON.stringify({
          temperature: userConfig?.temperature ?? 0.7,
          max_tokens: userConfig?.max_tokens ?? 4096,
          tools_mode: toolsMode,
          tools_enabled: toolsEnabled,
          approval_required: userConfig?.approval_required ?? false,
          // Conservative default: web search is opt-in. When an operator
          // builds a narrow allowlist they almost never want the browser
          // SDK search tool leaking in alongside it. Operators who want
          // it pass `web_search_enabled: true` or add `web_search` to
          // the allowlist explicitly.
          web_search_enabled: userConfig?.web_search_enabled ?? false,
          ...(display_name ? { display_name } : {}),
          ...(scheduled ? { scheduled } : {}),
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

      const { data } = await activeDb.from('agent_workforce_agents')
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
      const activeDb = resolveDb(req);
      const { workspaceId } = req;
      const { data, error } = await activeDb.from('agent_workforce_agents')
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
      const activeDb = resolveDb(req);
      const { workspaceId } = req;
      const allowedFields = [
        'voice_profile_id',
        'status',
        'autonomy_budget',
        'name',
        'role',
        'description',
        'system_prompt',
        'avatar_url',
        'department_id',
      ];
      const updates: Record<string, unknown> = {};

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }

      if (typeof updates.name === 'string' && !AGENT_NAME_RE.test(updates.name)) {
        res.status(400).json({
          error: 'name must be alphanumeric with dashes or underscores (no spaces)',
        });
        return;
      }

      // If renaming, enforce workspace-unique name.
      if (typeof updates.name === 'string') {
        const { data: conflict } = await activeDb.from('agent_workforce_agents')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('name', updates.name)
          .maybeSingle();
        if (conflict && (conflict as { id: string }).id !== req.params.id) {
          res.status(409).json({
            error: `An agent named "${updates.name}" already exists in this workspace.`,
          });
          return;
        }
      }

      // Top-level `enabled` is a convenience alias for the `status` column.
      if (req.body.enabled !== undefined && updates.status === undefined) {
        updates.status = req.body.enabled === false ? 'disabled' : 'idle';
      }

      // Handle config updates (merge into existing config). Accepts both the
      // nested `config` object and the top-level shortcut fields exposed by
      // the MCP update tool (display_name, scheduled).
      const configPatch: Record<string, unknown> = {};
      if (req.body.config !== undefined && typeof req.body.config === 'object') {
        Object.assign(configPatch, req.body.config);
      }
      if (req.body.display_name !== undefined) configPatch.display_name = req.body.display_name;
      if (req.body.scheduled !== undefined) configPatch.scheduled = req.body.scheduled;
      // Agents never pin a model — the router picks per task. Reject writes
      // that try to reintroduce a `model` field so the old deprecated shape
      // can't silently come back through the PATCH path.
      if ('model' in configPatch) {
        delete configPatch.model;
      }

      if (Array.isArray(configPatch.tools_enabled)) {
        const unknown = validateToolAllowlist(configPatch.tools_enabled as string[]);
        if (unknown.length > 0) {
          res.status(400).json({
            error: `Unknown tool name(s) in allowlist: ${unknown.join(', ')}.`,
          });
          return;
        }
      }

      if (Object.keys(configPatch).length > 0) {
        const { data: existing } = await activeDb.from('agent_workforce_agents')
          .select('config')
          .eq('id', req.params.id)
          .eq('workspace_id', workspaceId)
          .single();

        const existingConfig = existing
          ? (typeof existing.config === 'string' ? JSON.parse(existing.config) : (existing.config || {}))
          : {};
        updates.config = JSON.stringify({ ...existingConfig, ...configPatch });
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'No valid fields to update' });
        return;
      }

      updates.updated_at = new Date().toISOString();

      const { error } = await activeDb.from('agent_workforce_agents')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      // Return updated agent
      const { data } = await activeDb.from('agent_workforce_agents')
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
      const activeDb = resolveDb(req);
      const { workspaceId } = req;

      // Verify agent exists and belongs to workspace
      const { data: existing } = await activeDb.from('agent_workforce_agents')
        .select('id')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .single();

      if (!existing) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      // Delete agent memory
      await activeDb.from('agent_workforce_agent_memory')
        .delete()
        .eq('agent_id', req.params.id);

      // Delete the agent
      const { error } = await activeDb.from('agent_workforce_agents')
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
      const activeDb = resolveDb(req);
      const { workspaceId } = req;
      const { data: agent } = await activeDb.from('agent_workforce_agents')
        .select('id')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .single();

      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      const { runAgentMemoryMaintenance } = await import('../../lib/memory-maintenance.js');
      const result = await runAgentMemoryMaintenance(activeDb, workspaceId, { agentId: req.params.id });
      res.json({ data: result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Maintenance failed' });
    }
  });

  // Get agent budget status
  router.get('/api/agents/:id/budget-status', async (req, res) => {
    try {
      const activeDb = resolveDb(req);
      const { workspaceId } = req;
      const { data: agent, error } = await activeDb.from('agent_workforce_agents')
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
      const { data: todayRow } = await activeDb
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

      const { data: monthRows } = await activeDb
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
      const activeDb = resolveDb(req);
      const { data, error } = await activeDb.from('agent_workforce_agent_memory')
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
