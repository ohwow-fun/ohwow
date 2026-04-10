/**
 * Sequence Miner (E27) — GSP Algorithm on Action Journal
 *
 * Cross-agent sequence mining that discovers implicit business workflows
 * from the action journal. Groups tool calls by temporal proximity
 * (within 1 hour) to find cross-task patterns.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { WorkflowCandidate } from './types.js';
import { logger } from '../logger.js';

const MIN_SEQUENCE_LENGTH = 3;
const MAX_SEQUENCE_LENGTH = 8;
const MIN_FREQUENCY = 5;
const MAX_ENTRIES = 2000;
const TEMPORAL_WINDOW_MS = 60 * 60 * 1000;

interface JournalAction {
  toolName: string;
  agentId: string;
  taskId: string;
  createdAt: Date;
  durationMs: number;
}

function groupIntoSessions(actions: JournalAction[]): JournalAction[][] {
  if (actions.length === 0) return [];
  const sorted = [...actions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const sessions: JournalAction[][] = [];
  let currentSession: JournalAction[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].createdAt.getTime() - sorted[i - 1].createdAt.getTime();
    if (gap > TEMPORAL_WINDOW_MS) {
      if (currentSession.length >= MIN_SEQUENCE_LENGTH) {
        sessions.push(currentSession);
      }
      currentSession = [sorted[i]];
    } else {
      currentSession.push(sorted[i]);
    }
  }

  if (currentSession.length >= MIN_SEQUENCE_LENGTH) {
    sessions.push(currentSession);
  }

  return sessions;
}

function mineWorkflowCandidates(sessions: JournalAction[][], minFrequency: number): WorkflowCandidate[] {
  const patternMap = new Map<string, {
    toolSequence: string[];
    frequency: number;
    agentIds: Set<string>;
    taskIds: Set<string>;
    totalDurationMs: number;
  }>();

  for (const session of sessions) {
    const toolNames = session.map((a) => a.toolName);

    for (let len = MIN_SEQUENCE_LENGTH; len <= Math.min(MAX_SEQUENCE_LENGTH, toolNames.length); len++) {
      const seen = new Set<string>();

      for (let i = 0; i <= toolNames.length - len; i++) {
        const sub = toolNames.slice(i, i + len);
        const key = sub.join('→');
        if (seen.has(key)) continue;
        seen.add(key);

        const subActions = session.slice(i, i + len);
        const agentIds = new Set(subActions.map((a) => a.agentId));
        const taskIds = new Set(subActions.map((a) => a.taskId));
        const totalDuration = subActions.reduce((sum, a) => sum + a.durationMs, 0);

        const existing = patternMap.get(key);
        if (existing) {
          existing.frequency++;
          for (const id of agentIds) existing.agentIds.add(id);
          for (const id of taskIds) existing.taskIds.add(id);
          existing.totalDurationMs += totalDuration;
        } else {
          patternMap.set(key, { toolSequence: sub, frequency: 1, agentIds, taskIds, totalDurationMs: totalDuration });
        }
      }
    }
  }

  const candidates: WorkflowCandidate[] = [];
  for (const [, data] of patternMap) {
    if (data.frequency >= minFrequency) {
      candidates.push({
        toolSequence: data.toolSequence,
        frequency: data.frequency,
        agentIds: [...data.agentIds],
        sourceTaskIds: [...data.taskIds],
        avgDurationMs: Math.round(data.totalDurationMs / data.frequency),
      });
    }
  }

  candidates.sort((a, b) => {
    if (b.frequency !== a.frequency) return b.frequency - a.frequency;
    return b.toolSequence.length - a.toolSequence.length;
  });

  return candidates;
}

/**
 * Mine cross-agent workflow patterns from the action journal.
 */
/**
 * Load desktop automation journal entries from local JSONL files.
 * These are separate from the DB action journal and contain desktop_click,
 * desktop_type, desktop_screenshot, etc. actions.
 */
function loadDesktopJournalActions(dataDir: string, lookbackDays: number): JournalAction[] {
  try {
    const { readdirSync, readFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const journalDir = join(dataDir, 'desktop-journal');
    const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
    const actions: JournalAction[] = [];

    const files = readdirSync(journalDir).filter((f: string) => f.endsWith('.jsonl'));
    for (const file of files) {
      const lines = readFileSync(join(journalDir, file), 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { timestamp: string; sessionId: string; actionType: string; success: boolean; durationMs: number };
          const ts = new Date(entry.timestamp);
          if (ts.getTime() < cutoff) continue;
          actions.push({
            toolName: `desktop_${entry.actionType}`,
            agentId: '__orchestrator__',
            taskId: entry.sessionId,
            createdAt: ts,
            durationMs: entry.durationMs || 0,
          });
        } catch { /* skip malformed lines */ }
      }
    }
    return actions;
  } catch {
    // Journal dir doesn't exist or not readable
    return [];
  }
}

export async function mineWorkflowPatterns(
  db: DatabaseAdapter,
  workspaceId: string,
  lookbackDays = 30,
  dataDir?: string,
): Promise<WorkflowCandidate[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: entries } = await db
    .from('agent_workforce_action_journal')
    .select('tool_name, agent_id, task_id, created_at')
    .eq('workspace_id', workspaceId)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(MAX_ENTRIES);

  const actions: JournalAction[] = (entries || []).map((e) => {
    const row = e as Record<string, unknown>;
    return {
      toolName: row.tool_name as string,
      agentId: row.agent_id as string,
      taskId: row.task_id as string,
      createdAt: new Date(row.created_at as string),
      durationMs: 0,
    };
  });

  // Merge desktop journal actions if data dir is available
  if (dataDir) {
    const desktopActions = loadDesktopJournalActions(dataDir, lookbackDays);
    actions.push(...desktopActions);
    actions.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    logger.debug({ desktopActions: desktopActions.length }, '[SequenceMiner] Merged desktop journal actions');
  }

  if (actions.length < MIN_SEQUENCE_LENGTH * MIN_FREQUENCY) {
    logger.debug(
      { workspaceId, entryCount: actions.length },
      '[SequenceMiner] Not enough journal entries for mining',
    );
    return [];
  }

  const sessions = groupIntoSessions(actions);

  if (sessions.length === 0) {
    logger.debug({ workspaceId }, '[SequenceMiner] No sessions formed from journal entries');
    return [];
  }

  const candidates = mineWorkflowCandidates(sessions, MIN_FREQUENCY);

  logger.info(
    { workspaceId, entriesAnalyzed: actions.length, sessionsFormed: sessions.length, candidatesFound: candidates.length },
    '[SequenceMiner] Workflow mining completed',
  );

  return candidates;
}
