/**
 * Operational Pillars — "Should Be Doing" Engine (local runtime)
 *
 * Proactive Intelligence Layer (Phase 0 of Center of Operations).
 * Analyzes what a workspace SHOULD be doing based on business type
 * and growth stage, compares against what IS happening, and surfaces
 * gaps with actionable blueprints.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OperationalPillar {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  businessTypes: string[];
  minStage: number;
  maxStage: number;
  priorityByStage: Record<string, string>;
  kpis: Array<{ name: string; target: number | null; unit: string }>;
  setupSteps: Array<{ order: number; title: string; description: string; agent_role: string }>;
  estimatedSetupHours: number;
}

type Priority = 'critical' | 'important' | 'recommended' | 'nice_to_have';

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0, important: 1, recommended: 2, nice_to_have: 3,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonField<T>(raw: unknown, fallback: T): T {
  if (!raw) return fallback;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  }
  return raw as T;
}

function mapPillarRow(row: Record<string, unknown>): OperationalPillar {
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    description: row.description as string,
    category: row.category as string,
    icon: row.icon as string,
    businessTypes: parseJsonField<string[]>(row.business_types, []),
    minStage: row.min_stage as number,
    maxStage: row.max_stage as number,
    priorityByStage: parseJsonField<Record<string, string>>(row.priority_by_stage, {}),
    kpis: parseJsonField(row.kpis, []),
    setupSteps: parseJsonField(row.setup_steps, []),
    estimatedSetupHours: (row.estimated_setup_hours as number) || 1,
  };
}

function pillarApplies(p: OperationalPillar, businessType: string, stage: number): boolean {
  const typeMatch = p.businessTypes.length === 0 || p.businessTypes.includes(businessType);
  return typeMatch && stage >= p.minStage && stage <= p.maxStage;
}

function getPriority(p: OperationalPillar, stage: number): Priority {
  const direct = p.priorityByStage[String(stage)];
  if (direct) return direct as Priority;
  for (let s = stage - 1; s >= 0; s--) {
    const v = p.priorityByStage[String(s)];
    if (v) return v as Priority;
  }
  return 'nice_to_have';
}

// ---------------------------------------------------------------------------
// Tool Handlers
// ---------------------------------------------------------------------------

export async function assessOperations(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const categoryFilter = input.category_filter as string | undefined;
  const includeDismissed = (input.include_dismissed as boolean) || false;

  // 1. Get workspace
  const { data: workspace, error: wsErr } = await ctx.db
    .from('agent_workforce_workspaces')
    .select('business_type, growth_stage')
    .eq('id', ctx.workspaceId)
    .single();

  if (wsErr || !workspace) return { success: false, error: wsErr?.message || 'Workspace not found' };

  const businessType = workspace.business_type as string;
  const growthStage = (workspace.growth_stage as number) || 0;

  // 2. Get pillars
  let pillarsQ = ctx.db.from('agent_workforce_operational_pillars').select('*');
  if (categoryFilter) pillarsQ = pillarsQ.eq('category', categoryFilter);
  const { data: pillarsRaw, error: pErr } = await pillarsQ;
  if (pErr) return { success: false, error: pErr.message };

  const applicable = (pillarsRaw || []).map(mapPillarRow).filter((p) => pillarApplies(p, businessType, growthStage));

  // 3. Get instances
  const { data: instancesRaw } = await ctx.db
    .from('agent_workforce_pillar_instances')
    .select('*')
    .eq('workspace_id', ctx.workspaceId);

  const instanceMap = new Map((instancesRaw || []).map((i: Record<string, unknown>) => [i.pillar_id, i]));

  // 4. Build gaps
  type GapItem = { pillar: OperationalPillar; instance: Record<string, unknown> | null; priority: Priority; status: string; gap: string };
  const gaps: GapItem[] = applicable.map((pillar) => {
    const instance = (instanceMap.get(pillar.id) as Record<string, unknown>) || null;
    const priority = getPriority(pillar, growthStage);
    const status = (instance?.status as string) || 'missing';
    let gap: string;
    if (!instance || status === 'not_started') gap = 'not_started';
    else if (status === 'dismissed') gap = 'dismissed';
    else if (status === 'running' || status === 'optimizing') {
      gap = ((instance?.health_score as number) || 0) >= 0.6 ? 'healthy' : 'underperforming';
    } else gap = 'not_started';
    return { pillar, instance, priority, status: status === 'not_started' ? 'missing' : status, gap };
  });

  const filtered = includeDismissed ? gaps : gaps.filter((g) => g.gap !== 'dismissed');
  filtered.sort((a, b) => {
    if (a.gap === 'not_started' && b.gap !== 'not_started') return -1;
    if (b.gap === 'not_started' && a.gap !== 'not_started') return 1;
    if (a.gap === 'underperforming' && b.gap === 'healthy') return -1;
    if (b.gap === 'underperforming' && a.gap === 'healthy') return 1;
    return (PRIORITY_ORDER[a.priority] || 3) - (PRIORITY_ORDER[b.priority] || 3);
  });

  const missing = filtered.filter((g) => g.gap === 'not_started');
  const criticalMissing = missing.filter((g) => g.priority === 'critical');
  const importantMissing = missing.filter((g) => g.priority === 'important');
  const healthy = filtered.filter((g) => g.gap === 'healthy');
  const underperforming = filtered.filter((g) => g.gap === 'underperforming');

  return {
    success: true,
    data: {
      message: criticalMissing.length > 0
        ? `Found ${criticalMissing.length} critical operational gaps and ${importantMissing.length} important gaps for a ${businessType} at stage ${growthStage}. ${healthy.length} pillars are healthy.`
        : missing.length > 0
          ? `No critical gaps, but ${missing.length} operational pillars are not yet set up. ${healthy.length} are healthy.`
          : `All ${filtered.length} applicable operational pillars are active. ${underperforming.length} need attention.`,
      assessment: {
        businessType, growthStage,
        totalPillarsApplicable: filtered.length,
        missing: missing.length, underperforming: underperforming.length, healthy: healthy.length,
        criticalGaps: criticalMissing.map((g) => ({ slug: g.pillar.slug, name: g.pillar.name, category: g.pillar.category, description: g.pillar.description, estimatedSetupHours: g.pillar.estimatedSetupHours })),
        importantGaps: importantMissing.map((g) => ({ slug: g.pillar.slug, name: g.pillar.name, category: g.pillar.category, description: g.pillar.description, estimatedSetupHours: g.pillar.estimatedSetupHours })),
        allGaps: filtered.map((g) => ({ slug: g.pillar.slug, name: g.pillar.name, category: g.pillar.category, priority: g.priority, status: g.status, gap: g.gap })),
      },
    },
  };
}

export async function getPillarDetail(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const slug = input.pillar_slug as string;
  if (!slug) return { success: false, error: 'pillar_slug is required' };

  const { data: raw, error } = await ctx.db
    .from('agent_workforce_operational_pillars')
    .select('*')
    .eq('slug', slug)
    .single();
  if (error || !raw) return { success: false, error: error?.message || `Pillar "${slug}" not found` };

  const pillar = mapPillarRow(raw);

  const { data: instRaw } = await ctx.db
    .from('agent_workforce_pillar_instances')
    .select('*')
    .eq('workspace_id', ctx.workspaceId)
    .eq('pillar_id', pillar.id)
    .single();

  const { data: ws } = await ctx.db.from('agent_workforce_workspaces').select('growth_stage').eq('id', ctx.workspaceId).single();
  const priority = getPriority(pillar, (ws?.growth_stage as number) || 0);

  return {
    success: true,
    data: {
      pillar: { slug: pillar.slug, name: pillar.name, description: pillar.description, category: pillar.category, icon: pillar.icon, priority, kpis: pillar.kpis, setupSteps: pillar.setupSteps, estimatedSetupHours: pillar.estimatedSetupHours },
      currentStatus: instRaw ? { status: instRaw.status, mode: instRaw.mode, healthScore: instRaw.health_score, blueprint: parseJsonField(instRaw.blueprint, null) } : { status: 'not_started' },
    },
  };
}

export async function buildPillar(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const slug = input.pillar_slug as string;
  const customContext = input.custom_context as string | undefined;
  if (!slug) return { success: false, error: 'pillar_slug is required' };

  const { data: raw, error } = await ctx.db
    .from('agent_workforce_operational_pillars')
    .select('*')
    .eq('slug', slug)
    .single();
  if (error || !raw) return { success: false, error: error?.message || `Pillar "${slug}" not found` };

  const pillar = mapPillarRow(raw);

  const { data: ws } = await ctx.db
    .from('agent_workforce_workspaces')
    .select('business_name, business_type, business_description, growth_stage, team_size')
    .eq('id', ctx.workspaceId)
    .single();

  const now = new Date().toISOString();
  const blueprint = {
    pillarSlug: pillar.slug, pillarName: pillar.name, generatedAt: now,
    businessContext: ws ? { name: ws.business_name, type: ws.business_type, description: ws.business_description, stage: ws.growth_stage, teamSize: ws.team_size } : null,
    customContext: customContext || null,
    steps: pillar.setupSteps, kpis: pillar.kpis, estimatedSetupHours: pillar.estimatedSetupHours,
  };

  // Check if instance already exists
  const { data: existing } = await ctx.db
    .from('agent_workforce_pillar_instances')
    .select('id')
    .eq('workspace_id', ctx.workspaceId)
    .eq('pillar_id', pillar.id)
    .single();

  if (existing) {
    const { error: updateErr } = await ctx.db
      .from('agent_workforce_pillar_instances')
      .update({ status: 'building', mode: 'builder', blueprint: JSON.stringify(blueprint), building_started_at: now, updated_at: now })
      .eq('id', existing.id as string);
    if (updateErr) return { success: false, error: updateErr.message };
  } else {
    const { error: insertErr } = await ctx.db
      .from('agent_workforce_pillar_instances')
      .insert({
        id: crypto.randomUUID(), workspace_id: ctx.workspaceId, pillar_id: pillar.id,
        status: 'building', mode: 'builder',
        blueprint: JSON.stringify(blueprint),
        suggested_at: now, building_started_at: now, updated_at: now,
      });
    if (insertErr) return { success: false, error: insertErr.message };
  }

  return {
    success: true,
    data: {
      message: `Started building "${pillar.name}". The blueprint has ${pillar.setupSteps.length} setup steps. Estimated setup: ${pillar.estimatedSetupHours} hours.`,
      blueprint,
      nextAction: `Review the ${pillar.setupSteps.length} setup steps and begin executing them.`,
    },
  };
}

export async function updatePillarStatus(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const slug = input.pillar_slug as string;
  const newStatus = input.status as string;
  if (!slug) return { success: false, error: 'pillar_slug is required' };
  if (!newStatus) return { success: false, error: 'status is required' };

  const valid = ['running', 'optimizing', 'paused', 'dismissed'];
  if (!valid.includes(newStatus)) return { success: false, error: `Invalid status. Must be: ${valid.join(', ')}` };

  const { data: pillar, error: pErr } = await ctx.db
    .from('agent_workforce_operational_pillars')
    .select('id, name')
    .eq('slug', slug)
    .single();
  if (pErr || !pillar) return { success: false, error: pErr?.message || `Pillar "${slug}" not found` };

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { status: newStatus, updated_at: now };
  if (newStatus === 'running') updates.running_since = now;

  const { error } = await ctx.db
    .from('agent_workforce_pillar_instances')
    .update(updates)
    .eq('workspace_id', ctx.workspaceId)
    .eq('pillar_id', pillar.id as string);

  if (error) return { success: false, error: error.message };
  return { success: true, data: { message: `Updated "${pillar.name}" status to ${newStatus}.` } };
}
