/**
 * Work Router orchestrator tools (local runtime).
 * Phase 3 of Center of Operations.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { LocalWorkRouter } from '../../hexis/work-router.js';
import type { Urgency } from '../../hexis/work-router.js';

export const WORK_ROUTER_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'route_task',
    description: 'Route a task to the best person or agent. Scores candidates on skill match, capacity, energy alignment, growth value, transition stage, cost, and team balance. Auto-assigns when confidence is high.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_title: { type: 'string', description: 'Title/description of the task to route' },
        task_id: { type: 'string', description: 'Optional task ID to link the routing decision' },
        urgency: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Task urgency (default: normal)' },
        required_skills: { type: 'array', items: { type: 'string' }, description: 'Skills needed for this task' },
        estimated_effort_minutes: { type: 'number', description: 'Estimated effort in minutes' },
        preferred_assignee_id: { type: 'string', description: 'Optional preferred person/agent ID' },
        department_id: { type: 'string', description: 'Limit agent candidates to this department' },
      },
      required: ['task_title'],
    },
  },
  {
    name: 'get_routing_recommendations',
    description: 'Get routing recommendations for a task without recording a decision. Shows scored candidates with breakdown.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_title: { type: 'string', description: 'Title/description of the task' },
        urgency: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
        required_skills: { type: 'array', items: { type: 'string' } },
        estimated_effort_minutes: { type: 'number' },
      },
      required: ['task_title'],
    },
  },
  {
    name: 'get_workload_balance',
    description: 'Show workload distribution across people and agents this week. Active tasks, completions, quality scores.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'record_routing_outcome',
    description: 'Record the outcome of a routing decision. Tracks quality to improve future routing.',
    input_schema: {
      type: 'object' as const,
      properties: {
        decision_id: { type: 'string', description: 'Routing decision ID' },
        outcome: { type: 'string', enum: ['completed', 'reassigned', 'rejected', 'timed_out'] },
        quality_score: { type: 'number', description: '0-1 quality score' },
        actual_effort_minutes: { type: 'number', description: 'Actual effort in minutes' },
      },
      required: ['decision_id', 'outcome'],
    },
  },
  {
    name: 'get_task_augmentation',
    description: 'Get pre/co/post work augmentations for a routing decision. Shows what agents prepared or handled around a human task.',
    input_schema: {
      type: 'object' as const,
      properties: {
        decision_id: { type: 'string', description: 'Routing decision ID' },
      },
      required: ['decision_id'],
    },
  },
  {
    name: 'trigger_pre_work',
    description: 'Create a pre-work augmentation for a routed task. Agents gather context, pull docs, draft outlines before the human starts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        decision_id: { type: 'string', description: 'Routing decision ID' },
        augmentation_type: { type: 'string', description: 'Type: context_gathering, doc_summary, outline_draft, prior_art' },
        description: { type: 'string', description: 'What the pre-work should prepare' },
        agent_id: { type: 'string', description: 'Specific agent to handle it' },
      },
      required: ['decision_id'],
    },
  },
];

export async function routeTask(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const taskTitle = input.task_title as string;
  if (!taskTitle) return { success: false, error: 'task_title is required' };

  const router = new LocalWorkRouter(ctx.db, ctx.workspaceId);
  const decision = await router.routeTask({
    taskTitle,
    taskId: input.task_id as string | undefined,
    urgency: (input.urgency as Urgency) || 'normal',
    requiredSkills: input.required_skills as string[] | undefined,
    estimatedEffortMinutes: input.estimated_effort_minutes as number | undefined,
    preferredAssigneeId: input.preferred_assignee_id as string | undefined,
    departmentId: input.department_id as string | undefined,
  });

  const assigneeLabel = `${decision.assignee.name} (${decision.assignee.type})`;
  const methodLabel = decision.method === 'auto' ? 'Auto-assigned' : 'Recommended';

  return {
    success: true,
    data: {
      message: `${methodLabel}: ${assigneeLabel} (confidence ${Math.round(decision.confidence * 100)}%)`,
      decision: {
        id: decision.decisionId,
        assignee: { id: decision.assignee.id, name: decision.assignee.name, type: decision.assignee.type, score: decision.assignee.totalScore },
        runnerUp: decision.runnerUp ? { id: decision.runnerUp.id, name: decision.runnerUp.name, type: decision.runnerUp.type, score: decision.runnerUp.totalScore } : null,
        method: decision.method,
        confidence: decision.confidence,
        scores: decision.assignee.scores,
      },
    },
  };
}

export async function getRoutingRecommendations(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const taskTitle = input.task_title as string;
  if (!taskTitle) return { success: false, error: 'task_title is required' };

  const router = new LocalWorkRouter(ctx.db, ctx.workspaceId);
  const decision = await router.routeTask({
    taskTitle,
    urgency: (input.urgency as Urgency) || 'normal',
    requiredSkills: input.required_skills as string[] | undefined,
    estimatedEffortMinutes: input.estimated_effort_minutes as number | undefined,
  });

  return {
    success: true,
    data: {
      message: `Top recommendation: ${decision.assignee.name} (${decision.assignee.type}, ${Math.round(decision.confidence * 100)}% confidence)`,
      recommendation: {
        assignee: { id: decision.assignee.id, name: decision.assignee.name, type: decision.assignee.type, scores: decision.assignee.scores },
        runnerUp: decision.runnerUp ? { id: decision.runnerUp.id, name: decision.runnerUp.name, type: decision.runnerUp.type, scores: decision.runnerUp.scores } : null,
        confidence: decision.confidence,
      },
    },
  };
}

export async function getWorkloadBalance(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const router = new LocalWorkRouter(ctx.db, ctx.workspaceId);
  const balance = await router.getWorkloadBalance();

  if (balance.length === 0) {
    return { success: true, data: { message: 'No routing decisions yet. Route tasks with route_task first.', workload: [] } };
  }

  const totalActive = balance.reduce((s, b) => s + b.activeTasks, 0);
  const totalCompleted = balance.reduce((s, b) => s + b.completedThisWeek, 0);

  return {
    success: true,
    data: {
      message: `${balance.length} assignees. ${totalActive} active tasks. ${totalCompleted} completed this week.`,
      workload: balance,
    },
  };
}

export async function recordRoutingOutcome(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const decisionId = input.decision_id as string;
  if (!decisionId) return { success: false, error: 'decision_id is required' };

  const outcome = input.outcome as string;
  if (!outcome || !['completed', 'reassigned', 'rejected', 'timed_out'].includes(outcome)) {
    return { success: false, error: 'outcome must be completed, reassigned, rejected, or timed_out' };
  }

  const router = new LocalWorkRouter(ctx.db, ctx.workspaceId);
  await router.recordOutcome(
    decisionId,
    outcome as 'completed' | 'reassigned' | 'rejected' | 'timed_out',
    input.quality_score as number | undefined,
    input.actual_effort_minutes as number | undefined,
  );

  return { success: true, data: { message: `Outcome recorded: ${outcome}` } };
}

export async function getTaskAugmentation(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const decisionId = input.decision_id as string;
  if (!decisionId) return { success: false, error: 'decision_id is required' };

  const router = new LocalWorkRouter(ctx.db, ctx.workspaceId);
  const augmentations = await router.getAugmentationsForDecision(decisionId);

  return {
    success: true,
    data: {
      message: augmentations.length > 0
        ? `${augmentations.length} augmentation${augmentations.length !== 1 ? 's' : ''} for this task.`
        : 'No augmentations yet.',
      augmentations,
    },
  };
}

export async function triggerPreWork(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const decisionId = input.decision_id as string;
  if (!decisionId) return { success: false, error: 'decision_id is required' };

  const augType = input.augmentation_type as string || 'context_gathering';
  const description = input.description as string || 'Gather context and relevant docs for this task';

  const router = new LocalWorkRouter(ctx.db, ctx.workspaceId);
  const augId = await router.createAugmentation(decisionId, 'pre', augType, description, input.agent_id as string | undefined);

  return {
    success: true,
    data: { message: `Pre-work augmentation created: ${augType}`, augmentation_id: augId },
  };
}
