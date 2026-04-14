/**
 * Transition Engine orchestrator tools (local runtime).
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { LocalTransitionEngine, STAGE_NAMES } from '../../hexis/transition-engine.js';
import type { TransitionStage } from '../../hexis/transition-engine.js';

export const TRANSITION_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'get_transition_status',
    description: 'Show all task patterns and their transition stages (Shadow/Suggest/Draft/Autopilot/Autonomous). Shows time saved and automation progress.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'override_transition_stage',
    description: 'Manually promote or demote a task pattern to a different stage. Requires confirmation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        transition_id: { type: 'string', description: 'Transition ID' },
        new_stage: { type: 'number', description: '1=Shadow, 2=Suggest, 3=Draft, 4=Autopilot, 5=Autonomous' },
        reason: { type: 'string', description: 'Why the override' },
      },
      required: ['transition_id', 'new_stage', 'reason'],
    },
  },
  {
    name: 'detect_task_patterns',
    description: 'Scan recent task history for recurring patterns. Creates task patterns from clusters of 3+ similar tasks.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_time_saved',
    description: 'Get aggregate time saved by the Transition Engine. Shows hours saved, patterns tracked, automation rate.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
];

function parseJson<T>(raw: unknown, fallback: T): T {
  if (!raw) return fallback;
  if (typeof raw === 'string') { try { return JSON.parse(raw) as T; } catch { return fallback; } }
  return raw as T;
}

export async function getTransitionStatus(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const engine = new LocalTransitionEngine(ctx.db, ctx.workspaceId);
  const summary = await engine.getTransitionSummary();

  if (summary.length === 0) {
    return {
      success: true,
      data: {
        message: 'No task patterns detected yet. Run detect_task_patterns after 3+ similar tasks are completed.',
        transitions: [],
      },
    };
  }

  const totalTimeSaved = summary.reduce((s, t) => s + t.timeSavedMinutes, 0);

  return {
    success: true,
    data: {
      message: `${summary.length} task pattern${summary.length !== 1 ? 's' : ''} tracked. ${totalTimeSaved} minutes saved.`,
      transitions: summary,
    },
  };
}

export async function overrideTransitionStage(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const transitionId = input.transition_id as string;
  const newStage = input.new_stage as number;
  const reason = input.reason as string;

  if (!transitionId) return { success: false, error: 'transition_id is required' };
  if (!newStage || newStage < 1 || newStage > 5) return { success: false, error: 'new_stage must be 1-5' };
  if (!reason) return { success: false, error: 'reason is required' };

  const { data: t } = await ctx.db.from('task_transitions').select('current_stage, stage_history').eq('id', transitionId).single();
  if (!t) return { success: false, error: 'Transition not found' };

  const now = new Date().toISOString();
  const history = parseJson<Array<Record<string, unknown>>>(t.stage_history, []);
  history.push({ stage: t.current_stage, exited_at: now, reason: `manual: ${reason}` });

  await ctx.db.from('task_transitions').update({
    current_stage: newStage,
    stage_history: JSON.stringify(history),
    total_instances: 0, successful_instances: 0, correction_count: 0,
    updated_at: now,
  }).eq('id', transitionId);

  return {
    success: true,
    data: { message: `Overridden to Stage ${newStage} (${STAGE_NAMES[newStage as TransitionStage]}). Reason: ${reason}` },
  };
}

export async function detectTaskPatterns(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  // Get recent completed tasks
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const { data: tasks } = await ctx.db
    .from('agent_workforce_tasks')
    .select('id, title, agent_id')
    .eq('workspace_id', ctx.workspaceId)
    .in('status', ['completed', 'approved'])
    .gte('created_at', thirtyDaysAgo.toISOString());

  if (!tasks || tasks.length < 3) {
    return { success: true, data: { message: 'Not enough completed tasks yet (need 3+).', detected: 0 } };
  }

  // Simple clustering: group by first 3 keywords
  const clusters = new Map<string, Array<typeof tasks[0]>>();
  for (const task of tasks) {
    const keywords = (task.title as string).toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w: string) => w.length > 2).slice(0, 3).sort().join('_');
    if (!keywords) continue;
    const list = clusters.get(keywords) || [];
    list.push(task);
    clusters.set(keywords, list);
  }

  let created = 0;
  for (const [key, clusterTasks] of clusters) {
    if (clusterTasks.length < 3) continue;

    // Check for existing pattern
    const keywords = key.split('_');
    const { data: existing } = await ctx.db
      .from('task_patterns')
      .select('id')
      .eq('workspace_id', ctx.workspaceId)
      .eq('name', keywords.join(' '));

    if (existing && existing.length > 0) continue;

    await ctx.db.from('task_patterns').insert({
      id: crypto.randomUUID(),
      workspace_id: ctx.workspaceId,
      name: keywords.join(' '),
      category: 'general',
      detection_method: 'auto_detected',
      title_keywords: JSON.stringify(keywords),
      instance_count: clusterTasks.length,
      first_observed_at: new Date().toISOString(),
      last_observed_at: new Date().toISOString(),
    });
    created++;
  }

  return {
    success: true,
    data: { message: `Detected ${created} new task pattern${created !== 1 ? 's' : ''} from ${tasks.length} completed tasks.`, detected: created },
  };
}

export async function getTimeSaved(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const engine = new LocalTransitionEngine(ctx.db, ctx.workspaceId);
  const metrics = await engine.getTimeSavedMetrics();
  const hours = Math.round(metrics.totalMinutesSaved / 60 * 10) / 10;

  return {
    success: true,
    data: {
      message: metrics.patternsTracked > 0
        ? `${metrics.patternsTracked} patterns tracked. ${hours} hours saved. ${metrics.patternsAtAutopilotOrAbove} at Autopilot+. Automation: ${Math.round(metrics.automationRate * 100)}%.`
        : 'No patterns tracked yet.',
      metrics,
    },
  };
}
