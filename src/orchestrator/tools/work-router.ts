/**
 * Work Router orchestrator tools (local runtime).
 * Phase 3 of Center of Operations.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { LocalWorkRouter } from '../../hexis/work-router.js';
import type { Urgency } from '../../hexis/work-router.js';

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
