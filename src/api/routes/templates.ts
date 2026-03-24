/**
 * Templates API Routes (Local)
 *
 * Provides template gallery + install endpoints for the workspace runtime.
 * Templates are stored in the local SQLite `template_bundles` table,
 * seeded from the TypeScript seed data on first access.
 *
 *   GET    /api/templates              — list all active templates
 *   GET    /api/templates/:slug        — get single template
 *   POST   /api/templates/:slug/install — install template (create agents + automations)
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';
import { AutomationService } from '../../triggers/automation-service.js';

interface SeedTemplate {
  slug: string;
  name: string;
  description: string;
  long_description: string | null;
  icon: string;
  category: string;
  business_types: string[];
  tags: string[];
  difficulty: string;
  agents: Array<{
    ref_id: string;
    name: string;
    role: string;
    description: string;
    system_prompt: string;
    department: string;
    tools: string[];
    config: Record<string, unknown>;
  }>;
  automations: Array<{
    ref_id: string;
    name: string;
    description: string;
    trigger_type: string;
    trigger_config: Record<string, unknown>;
    steps: Array<{
      id: string;
      step_type: string;
      label: string;
      agent_ref?: string;
      prompt?: string;
      action_config?: Record<string, unknown>;
    }>;
    cooldown_seconds?: number;
  }>;
  variables: Array<Record<string, unknown>>;
  featured: boolean;
  sort_order: number;
}

function resolveVariables(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}

export function createTemplatesRouter(
  db: DatabaseAdapter,
  workspaceId: string,
): Router {
  const router = Router();
  let seeded = false;

  // Seed templates from TypeScript const if table is empty
  async function ensureSeeded() {
    if (seeded) return;
    seeded = true;

    try {
      const { data: existing } = await db
        .from('template_bundles')
        .select('id')
        .limit(1);

      if (existing && existing.length > 0) return;

      // Dynamic import to avoid bundling issues
      const { SEED_TEMPLATES } = await import('../../lib/seed-templates.js');

      for (const tmpl of SEED_TEMPLATES as SeedTemplate[]) {
        await db.from('template_bundles').insert({
          id: randomUUID(),
          slug: tmpl.slug,
          name: tmpl.name,
          description: tmpl.description,
          long_description: tmpl.long_description || null,
          icon: tmpl.icon,
          category: tmpl.category,
          business_types: JSON.stringify(tmpl.business_types),
          tags: JSON.stringify(tmpl.tags),
          difficulty: tmpl.difficulty,
          agents: JSON.stringify(tmpl.agents),
          automations: JSON.stringify(tmpl.automations),
          variables: JSON.stringify(tmpl.variables),
          featured: tmpl.featured ? 1 : 0,
          sort_order: tmpl.sort_order,
          install_count: 0,
          is_active: 1,
        });
      }
    } catch (err) {
      logger.error({ err }, '[Templates] Seed error');
      seeded = false;
    }
  }

  function parseRow(row: Record<string, unknown>) {
    return {
      ...row,
      business_types: typeof row.business_types === 'string' ? JSON.parse(row.business_types as string) : row.business_types,
      tags: typeof row.tags === 'string' ? JSON.parse(row.tags as string) : row.tags,
      agents: typeof row.agents === 'string' ? JSON.parse(row.agents as string) : row.agents,
      automations: typeof row.automations === 'string' ? JSON.parse(row.automations as string) : row.automations,
      variables: typeof row.variables === 'string' ? JSON.parse(row.variables as string) : row.variables,
      featured: !!row.featured,
      is_active: !!row.is_active,
    };
  }

  // List active templates
  router.get('/api/templates', async (_req, res) => {
    try {
      await ensureSeeded();
      const { data, error } = await db
        .from('template_bundles')
        .select('*')
        .eq('is_active', 1)
        .order('sort_order', { ascending: true });

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      // Check installed status
      const { data: installs } = await db
        .from('template_installs')
        .select('template_slug');

      const installedSlugs = new Set(
        (installs || []).map((i: Record<string, unknown>) => i.template_slug as string),
      );

      const templates = (data || []).map((row: Record<string, unknown>) => ({
        ...parseRow(row),
        installed: installedSlugs.has(row.slug as string),
      }));

      res.json({ templates });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Get single template
  router.get('/api/templates/:slug', async (req, res) => {
    try {
      await ensureSeeded();
      const { data, error } = await db
        .from('template_bundles')
        .select('*')
        .eq('slug', req.params.slug)
        .eq('is_active', 1)
        .single();

      if (error || !data) {
        res.status(404).json({ error: 'Template not found' });
        return;
      }

      const { data: install } = await db
        .from('template_installs')
        .select('id')
        .eq('template_slug', req.params.slug)
        .single();

      res.json({ template: { ...parseRow(data as Record<string, unknown>), installed: !!install } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Install template
  router.post('/api/templates/:slug/install', async (req, res) => {
    try {
      await ensureSeeded();
      const { slug } = req.params;
      const { variableValues = {} } = req.body as { variableValues?: Record<string, string> };

      // Check not already installed
      const { data: existingInstall } = await db
        .from('template_installs')
        .select('id')
        .eq('template_slug', slug)
        .single();

      if (existingInstall) {
        res.status(400).json({ error: 'Already installed' });
        return;
      }

      // Fetch template
      const { data: tmplRow, error: tmplError } = await db
        .from('template_bundles')
        .select('*')
        .eq('slug', slug)
        .eq('is_active', 1)
        .single();

      if (tmplError || !tmplRow) {
        res.status(404).json({ error: 'Template not found' });
        return;
      }

      const tmpl = parseRow(tmplRow as Record<string, unknown>) as ReturnType<typeof parseRow> & {
        agents: SeedTemplate['agents'];
        automations: SeedTemplate['automations'];
      };

      // Create agents
      const refIdToRealId: Record<string, string> = {};
      const agentIds: string[] = [];

      for (const agent of tmpl.agents) {
        // Find or create department
        const { data: existingDept } = await db
          .from('departments')
          .select('id')
          .eq('name', agent.department)
          .single();

        let deptId: string;
        if (existingDept) {
          deptId = (existingDept as Record<string, unknown>).id as string;
        } else {
          const newDeptId = randomUUID();
          await db.from('departments').insert({
            id: newDeptId,
            name: agent.department,
            description: `${agent.department} department`,
            icon: 'Buildings',
            color: '#6366f1',
            sort_order: 0,
          });
          deptId = newDeptId;
        }

        const agentId = randomUUID();
        await db.from('agents').insert({
          id: agentId,
          department_id: deptId,
          name: resolveVariables(agent.name, variableValues),
          role: resolveVariables(agent.role, variableValues),
          description: resolveVariables(agent.description, variableValues),
          system_prompt: resolveVariables(agent.system_prompt, variableValues),
          config: JSON.stringify(agent.config),
          status: 'idle',
          stats: JSON.stringify({ total_tasks: 0, completed_tasks: 0, failed_tasks: 0, tokens_used: 0 }),
        });

        refIdToRealId[agent.ref_id] = agentId;
        agentIds.push(agentId);
      }

      // Create automations
      const automationService = new AutomationService(db, workspaceId);
      const automationIds: string[] = [];

      for (const automation of tmpl.automations) {
        const resolvedSteps = automation.steps.map((step: { id: string; step_type: string; label: string; agent_ref?: string; prompt?: string; action_config?: Record<string, unknown> }) => ({
          ...step,
          agent_id: step.agent_ref ? refIdToRealId[step.agent_ref] || step.agent_ref : undefined,
          agent_ref: undefined,
          prompt: step.prompt ? resolveVariables(step.prompt, variableValues) : undefined,
          label: resolveVariables(step.label, variableValues),
        }));

        const created = await automationService.create({
          name: resolveVariables(automation.name, variableValues),
          description: resolveVariables(automation.description, variableValues),
          trigger_type: automation.trigger_type as 'webhook' | 'schedule' | 'event' | 'manual',
          trigger_config: automation.trigger_config,
          steps: resolvedSteps,
          cooldown_seconds: automation.cooldown_seconds,
        });

        automationIds.push(created.id);
      }

      // Record the install
      await db.from('template_installs').insert({
        id: randomUUID(),
        template_slug: slug,
        agent_ids: JSON.stringify(agentIds),
        automation_ids: JSON.stringify(automationIds),
        variable_values: JSON.stringify(variableValues),
      });

      // Increment install count
      await db
        .from('template_bundles')
        .update({ install_count: ((tmplRow as Record<string, unknown>).install_count as number || 0) + 1 })
        .eq('slug', slug);

      res.status(201).json({ agentIds, automationIds });
    } catch (err) {
      logger.error({ err }, '[Templates] Install error');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
