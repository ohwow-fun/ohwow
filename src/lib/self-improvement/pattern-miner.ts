/**
 * Pattern Miner (E22) — Prefix-Span Mining on Tool Sequences
 *
 * Extracts recurring tool-call subsequences from ReAct traces
 * stored in task metadata. Uses a simplified prefix-span algorithm
 * to find subsequences of length 2-6 that appear in 3+ tasks.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { MinedPattern, ToolCall } from './types.js';
import { logger } from '../logger.js';

const MIN_SEQUENCE_LENGTH = 2;
const MAX_SEQUENCE_LENGTH = 6;
const MIN_SUPPORT = 3;
const MAX_TASKS_PER_AGENT = 100;

interface ReActAction {
  tool: string;
  inputSummary: string;
}

interface ReActObservation {
  tool: string;
  resultSummary: string;
  success: boolean;
}

interface ReActStep {
  actions: ReActAction[];
  observations: ReActObservation[];
}

function extractToolSequence(reactTrace: ReActStep[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const step of reactTrace) {
    for (const action of step.actions) {
      const observation = step.observations.find((o) => o.tool === action.tool);
      calls.push({
        tool: action.tool,
        inputSummary: action.inputSummary,
        success: observation?.success ?? true,
      });
    }
  }
  return calls;
}

function toToolNames(calls: ToolCall[]): string[] {
  return calls.map((c) => c.tool);
}

function getSubsequences(sequence: string[], length: number): string[][] {
  const subs: string[][] = [];
  for (let i = 0; i <= sequence.length - length; i++) {
    subs.push(sequence.slice(i, i + length));
  }
  return subs;
}

function mineFrequentSubsequences(
  taskSequences: Array<{ taskId: string; tools: string[]; successRate: number }>,
  minSupport: number
): MinedPattern[] {
  const patternMap = new Map<string, {
    toolSequence: string[];
    taskIds: string[];
    successRates: number[];
  }>();

  for (let len = MIN_SEQUENCE_LENGTH; len <= MAX_SEQUENCE_LENGTH; len++) {
    for (const { taskId, tools, successRate } of taskSequences) {
      const subs = getSubsequences(tools, len);
      const seen = new Set<string>();
      for (const sub of subs) {
        const key = sub.join('→');
        if (seen.has(key)) continue;
        seen.add(key);
        const existing = patternMap.get(key);
        if (existing) {
          existing.taskIds.push(taskId);
          existing.successRates.push(successRate);
        } else {
          patternMap.set(key, { toolSequence: sub, taskIds: [taskId], successRates: [successRate] });
        }
      }
    }
  }

  const patterns: MinedPattern[] = [];
  for (const [, data] of patternMap) {
    if (data.taskIds.length >= minSupport) {
      const avgSuccess = data.successRates.reduce((a, b) => a + b, 0) / data.successRates.length;
      patterns.push({
        toolSequence: data.toolSequence,
        support: data.taskIds.length,
        sourceTaskIds: data.taskIds,
        avgSuccessRate: avgSuccess,
      });
    }
  }

  patterns.sort((a, b) => {
    if (b.support !== a.support) return b.support - a.support;
    return b.toolSequence.length - a.toolSequence.length;
  });

  return patterns;
}

/**
 * Mine tool-call patterns from an agent's completed task traces.
 */
export async function mineToolPatterns(
  db: DatabaseAdapter,
  workspaceId: string,
  agentId: string
): Promise<MinedPattern[]> {
  const { data: tasks } = await db
    .from('agent_workforce_tasks')
    .select('id, metadata')
    .eq('workspace_id', workspaceId)
    .eq('agent_id', agentId)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(MAX_TASKS_PER_AGENT);

  if (!tasks || tasks.length === 0) {
    logger.debug({ agentId }, '[PatternMiner] No completed tasks found');
    return [];
  }

  const taskSequences: Array<{ taskId: string; tools: string[]; successRate: number }> = [];

  for (const task of tasks) {
    const metadata = (task as Record<string, unknown>).metadata as Record<string, unknown> | null;
    const reactTrace = metadata?.react_trace as ReActStep[] | undefined;
    if (!reactTrace || reactTrace.length === 0) continue;

    const toolCalls = extractToolSequence(reactTrace);
    if (toolCalls.length < MIN_SEQUENCE_LENGTH) continue;

    const tools = toToolNames(toolCalls);
    const successCount = toolCalls.filter((c) => c.success).length;
    const successRate = toolCalls.length > 0 ? successCount / toolCalls.length : 0;

    taskSequences.push({
      taskId: (task as Record<string, unknown>).id as string,
      tools,
      successRate,
    });
  }

  if (taskSequences.length < MIN_SUPPORT) {
    logger.debug({ agentId, tracesFound: taskSequences.length }, '[PatternMiner] Not enough traces for mining');
    return [];
  }

  const patterns = mineFrequentSubsequences(taskSequences, MIN_SUPPORT);

  logger.info(
    { agentId, tracesAnalyzed: taskSequences.length, patternsFound: patterns.length },
    '[PatternMiner] Pattern mining completed',
  );

  return patterns;
}
