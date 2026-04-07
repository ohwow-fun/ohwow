/**
 * Promotion Engine (Local Runtime) — Agent Lifecycle Transitions
 *
 * Manages ephemeral → provisional → established → permanent lifecycle.
 * Uses SQLite DatabaseAdapter for all queries.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

type LifecycleStage = 'ephemeral' | 'provisional' | 'established' | 'permanent' | 'archived';

export interface PromotionCheckResult {
  agentId: string;
  currentStage: LifecycleStage;
  newStage: LifecycleStage | null;
  reason: string;
}

// ============================================================================
// THRESHOLDS
// ============================================================================

const THRESHOLDS = {
  ephemeralToProvisional: { minTasks: 1, minSuccessRate: 0.6 },
  provisionalToEstablished: { minTasks: 3, minSuccessRate: 0.75 },
  demotionThreshold: { minTasks: 5, maxSuccessRate: 0.5 },
  ephemeralTtlDays: 7,
};

// ============================================================================
// MAIN FUNCTIONS
// ============================================================================

export async function checkPromotion(
  db: DatabaseAdapter,
  workspaceId: string,
  agentId: string,
): Promise<PromotionCheckResult> {
  const { data: agent } = await db
    .from('agent_workforce_agents')
    .select('id, name, lifecycle_stage')
    .eq('id', agentId)
    .single();

  if (!agent) {
    return { agentId, currentStage: 'permanent', newStage: null, reason: 'Agent not found' };
  }

  const a = agent as { id: string; name: string; lifecycle_stage: string };
  const currentStage = a.lifecycle_stage as LifecycleStage;

  if (currentStage === 'permanent' || currentStage === 'archived') {
    return { agentId, currentStage, newStage: null, reason: 'Already at terminal stage' };
  }

  // Load task stats
  const { data: completedRows } = await db
    .from('agent_workforce_tasks')
    .select('id')
    .eq('agent_id', agentId)
    .eq('workspace_id', workspaceId)
    .eq('status', 'completed');

  const { data: failedRows } = await db
    .from('agent_workforce_tasks')
    .select('id')
    .eq('agent_id', agentId)
    .eq('workspace_id', workspaceId)
    .eq('status', 'failed');

  const completed = (completedRows as unknown[])?.length ?? 0;
  const failed = (failedRows as unknown[])?.length ?? 0;
  const total = completed + failed;
  const successRate = total > 0 ? completed / total : 0;

  // Check demotion
  if (
    (currentStage === 'provisional' || currentStage === 'established') &&
    total >= THRESHOLDS.demotionThreshold.minTasks &&
    successRate <= THRESHOLDS.demotionThreshold.maxSuccessRate
  ) {
    const newStage: LifecycleStage = currentStage === 'established' ? 'provisional' : 'ephemeral';
    await transitionAgent(db, workspaceId, agentId, currentStage, newStage, `Success rate ${Math.round(successRate * 100)}% below threshold`);
    return { agentId, currentStage, newStage, reason: 'Performance declined' };
  }

  // Check promotion
  if (currentStage === 'ephemeral') {
    const t = THRESHOLDS.ephemeralToProvisional;
    if (total >= t.minTasks && successRate >= t.minSuccessRate) {
      await transitionAgent(db, workspaceId, agentId, 'ephemeral', 'provisional', `${completed}/${total} tasks successful`);
      return { agentId, currentStage, newStage: 'provisional', reason: 'First successful task' };
    }
  }

  if (currentStage === 'provisional') {
    const t = THRESHOLDS.provisionalToEstablished;
    if (total >= t.minTasks && successRate >= t.minSuccessRate) {
      await transitionAgent(db, workspaceId, agentId, 'provisional', 'established', `${completed}/${total} tasks successful`);
      return { agentId, currentStage, newStage: 'established', reason: 'Consistent performance' };
    }
  }

  return { agentId, currentStage, newStage: null, reason: 'Criteria not yet met' };
}

export async function checkSequencePromotions(
  db: DatabaseAdapter,
  workspaceId: string,
  agentIds: string[],
): Promise<PromotionCheckResult[]> {
  const results: PromotionCheckResult[] = [];
  for (const agentId of agentIds) {
    const result = await checkPromotion(db, workspaceId, agentId);
    if (result.newStage) results.push(result);
  }
  return results;
}

// ============================================================================
// HELPERS
// ============================================================================

async function transitionAgent(
  db: DatabaseAdapter,
  workspaceId: string,
  agentId: string,
  fromStage: LifecycleStage,
  toStage: LifecycleStage,
  reason: string,
): Promise<void> {
  await db
    .from('agent_workforce_agents')
    .update({ lifecycle_stage: toStage, promoted_at: new Date().toISOString() })
    .eq('id', agentId);

  await db
    .from('agent_workforce_lifecycle_events')
    .insert({
      agent_id: agentId,
      workspace_id: workspaceId,
      event_type: toStage === 'archived' ? 'archived' : 'promoted',
      from_stage: fromStage,
      to_stage: toStage,
      reason,
      metrics: JSON.stringify({}),
    });

  logger.info({ agentId, fromStage, toStage, reason }, '[PromotionEngine] Lifecycle transition');
}
