/**
 * Goal Checkpoints — automatic detection and tracking of conversational goals.
 *
 * Identifies goals from conversation exchanges, checkpoints them when achieved,
 * and carries them forward across sessions for cross-conversation continuity.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { ModelRouter } from '../execution/model-router.js';
import { logger } from '../lib/logger.js';
import { randomUUID } from 'crypto';

// ============================================================================
// TYPES
// ============================================================================

export interface GoalCheckpoint {
  id: string;
  conversationId: string;
  goalText: string;
  status: 'active' | 'achieved' | 'abandoned' | 'deferred';
  contextSnapshot: string | null;
  messageIndex: number | null;
  createdAt: string;
}

export interface GoalCheckpointDeps {
  db: DatabaseAdapter;
  workspaceId: string;
  modelRouter: ModelRouter | null;
}

// ============================================================================
// EXTRACTION PROMPT
// ============================================================================

const GOAL_EXTRACTION_PROMPT = `You analyze conversation exchanges to detect goals and track their status.

Given the latest exchange and a list of existing active goals, respond with ONLY valid JSON:
{
  "new": [{"goal_text": "clear, actionable goal"}],
  "achieved": ["goalId1"],
  "abandoned": ["goalId2"]
}

Rules:
- Only extract CLEAR goals the user expressed or strongly implied (not vague wishes)
- A goal is "achieved" when the conversation confirms it was completed
- A goal is "abandoned" when the user explicitly moved on or said to skip it
- Return empty arrays if nothing changed
- Max 2 new goals per exchange`;

// ============================================================================
// EXTRACT GOAL CHECKPOINTS
// ============================================================================

/**
 * Extract and update goal checkpoints from a conversation exchange.
 * Runs fire-and-forget after each exchange.
 */
export async function extractGoalCheckpoints(
  deps: GoalCheckpointDeps,
  conversationId: string,
  userMessage: string,
  assistantResponse: string,
  messageIndex: number,
): Promise<void> {
  if (!deps.modelRouter) return;

  try {
    // Load existing active goals for this workspace
    const { data: existingGoals } = await deps.db
      .from('orchestrator_goal_checkpoints')
      .select('id, goal_text, status')
      .eq('workspace_id', deps.workspaceId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(10);

    const goalsContext = (existingGoals ?? []).map((g) => {
      const row = g as Record<string, unknown>;
      return `- [${row.id}] ${row.goal_text}`;
    }).join('\n');

    const provider = await deps.modelRouter.getProvider('memory_extraction');
    if (!provider?.createMessage) return;

    const response = await provider.createMessage({
      system: GOAL_EXTRACTION_PROMPT,
      messages: [{
        role: 'user',
        content: `Active goals:\n${goalsContext || '(none)'}\n\nLatest exchange:\nUser: ${userMessage.slice(0, 500)}\nAssistant: ${assistantResponse.slice(0, 500)}`,
      }],
      maxTokens: 300,
      temperature: 0,
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const result = JSON.parse(jsonMatch[0]) as {
      new?: Array<{ goal_text: string }>;
      achieved?: string[];
      abandoned?: string[];
    };

    // Insert new goals
    if (result.new && result.new.length > 0) {
      for (const goal of result.new.slice(0, 2)) {
        if (!goal.goal_text || goal.goal_text.length < 5) continue;
        await deps.db.from('orchestrator_goal_checkpoints').insert({
          id: randomUUID(),
          conversation_id: conversationId,
          workspace_id: deps.workspaceId,
          goal_text: goal.goal_text,
          status: 'active',
          message_index: messageIndex,
        });
        logger.debug({ goal: goal.goal_text }, '[goals] New goal checkpoint created');
      }
    }

    // Mark goals as achieved
    if (result.achieved && result.achieved.length > 0) {
      for (const goalId of result.achieved) {
        await deps.db
          .from('orchestrator_goal_checkpoints')
          .update({ status: 'achieved', achieved_at: new Date().toISOString() })
          .eq('id', goalId)
          .eq('workspace_id', deps.workspaceId);
        logger.debug({ goalId }, '[goals] Goal marked as achieved');
      }
    }

    // Mark goals as abandoned
    if (result.abandoned && result.abandoned.length > 0) {
      for (const goalId of result.abandoned) {
        await deps.db
          .from('orchestrator_goal_checkpoints')
          .update({ status: 'abandoned' })
          .eq('id', goalId)
          .eq('workspace_id', deps.workspaceId);
      }
    }
  } catch (err) {
    logger.debug({ err }, '[goals] Goal extraction failed (non-fatal)');
  }
}

// ============================================================================
// LOAD ACTIVE GOALS
// ============================================================================

/**
 * Load active goal checkpoints for a workspace (across all sessions).
 */
export async function loadActiveGoals(
  deps: GoalCheckpointDeps,
): Promise<GoalCheckpoint[]> {
  try {
    const { data } = await deps.db
      .from('orchestrator_goal_checkpoints')
      .select('id, conversation_id, goal_text, status, context_snapshot, message_index, created_at')
      .eq('workspace_id', deps.workspaceId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(10);

    if (!data) return [];
    return data.map((row) => ({
      id: (row as Record<string, unknown>).id as string,
      conversationId: (row as Record<string, unknown>).conversation_id as string,
      goalText: (row as Record<string, unknown>).goal_text as string,
      status: (row as Record<string, unknown>).status as GoalCheckpoint['status'],
      contextSnapshot: (row as Record<string, unknown>).context_snapshot as string | null,
      messageIndex: (row as Record<string, unknown>).message_index as number | null,
      createdAt: (row as Record<string, unknown>).created_at as string,
    }));
  } catch {
    return [];
  }
}

// ============================================================================
// FORMAT FOR SYSTEM PROMPT
// ============================================================================

/**
 * Format active goals for injection into the system prompt.
 */
export function formatGoalsForPrompt(goals: GoalCheckpoint[]): string {
  if (goals.length === 0) return '';

  const lines = ['## Active Goals', 'Goals from this and previous sessions:'];
  for (const g of goals) {
    lines.push(`- ${g.goalText}`);
  }
  return lines.join('\n');
}
