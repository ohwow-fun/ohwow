/**
 * Transition Engine — Local Runtime
 *
 * Coordinates pattern detection and stage progression for the
 * 5-stage handoff (Shadow → Suggest → Draft → Autopilot → Autonomous).
 * Integrates with the Habit Engine for pattern promotion.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransitionStage = 1 | 2 | 3 | 4 | 5;

export const STAGE_NAMES: Record<TransitionStage, string> = {
  1: 'Shadow', 2: 'Suggest', 3: 'Draft', 4: 'Autopilot', 5: 'Autonomous',
};

export interface CompletedTask {
  taskId: string;
  taskTitle: string;
  agentId: string;
  toolsUsed: string[];
  status: string;
  truthScore: number | null;
  durationSeconds: number;
  humanEdited?: boolean;
  humanRejected?: boolean;
}

export interface TransitionSummary {
  patternId: string;
  patternName: string;
  patternCategory: string;
  transitionId: string;
  currentStage: TransitionStage;
  stageName: string;
  confidenceScore: number;
  totalInstances: number;
  timeSavedMinutes: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'my', 'your',
]);

const MATCH_THRESHOLD = 0.6;

interface PromotionThreshold {
  minInstances: number;
  minSuccessRate: number;
  maxEditRate: number;
  maxCorrections: number;
}

const PROMOTION_THRESHOLDS: Record<number, PromotionThreshold> = {
  1: { minInstances: 5, minSuccessRate: 0.7, maxEditRate: 1.0, maxCorrections: 5 },
  2: { minInstances: 5, minSuccessRate: 0.8, maxEditRate: 0.8, maxCorrections: 3 },
  3: { minInstances: 10, minSuccessRate: 0.85, maxEditRate: 0.2, maxCorrections: 2 },
  4: { minInstances: 15, minSuccessRate: 0.95, maxEditRate: 0.05, maxCorrections: 0 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (!raw) return fallback;
  if (typeof raw === 'string') { try { return JSON.parse(raw) as T; } catch { return fallback; } }
  return raw as T;
}

// ---------------------------------------------------------------------------
// Transition Engine
// ---------------------------------------------------------------------------

export class LocalTransitionEngine {
  constructor(private db: DatabaseAdapter, private workspaceId: string) {}

  /**
   * Called after every task completion.
   */
  async onTaskCompleted(task: CompletedTask): Promise<void> {
    try {
      // 1. Match to pattern
      const patternId = await this.matchToPattern(task.taskTitle, task.toolsUsed);
      if (!patternId) return;

      // 2. Get or create transition
      const transitionId = await this.getOrCreateTransition(patternId);

      // 3. Update pattern stats
      await this.db.from('task_patterns').update({
        instance_count: undefined, // will be incremented below
        last_observed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', patternId);

      // Increment instance_count
      const { data: pattern } = await this.db.from('task_patterns').select('instance_count').eq('id', patternId).single();
      if (pattern) {
        await this.db.from('task_patterns').update({ instance_count: ((pattern.instance_count as number) || 0) + 1 }).eq('id', patternId);
      }

      // 4. Evaluate progression
      await this.evaluateProgression(transitionId, {
        success: task.status === 'completed',
        humanEdited: task.humanEdited || false,
        humanRejected: task.humanRejected || false,
        correctionApplied: task.humanEdited || false,
      });
    } catch (err) {
      logger.warn({ err, taskId: task.taskId }, 'Transition engine: error');
    }
  }

  /**
   * Get summary for dashboard/tools.
   */
  async getTransitionSummary(): Promise<TransitionSummary[]> {
    const { data: transitions } = await this.db
      .from('task_transitions')
      .select('*')
      .eq('workspace_id', this.workspaceId)
      .eq('active', 1);

    if (!transitions || transitions.length === 0) return [];

    const patternIds = transitions.map((t) => t.pattern_id as string);
    const results: TransitionSummary[] = [];

    for (const t of transitions) {
      const { data: pattern } = await this.db.from('task_patterns').select('name, category').eq('id', t.pattern_id as string).single();
      if (!pattern) continue;

      const stage = (t.current_stage as number) as TransitionStage;
      results.push({
        patternId: t.pattern_id as string,
        patternName: pattern.name as string,
        patternCategory: pattern.category as string,
        transitionId: t.id as string,
        currentStage: stage,
        stageName: STAGE_NAMES[stage],
        confidenceScore: (t.confidence_score as number) || 0,
        totalInstances: (t.total_instances as number) || 0,
        timeSavedMinutes: (t.time_saved_minutes as number) || 0,
      });
    }

    return results;
  }

  /**
   * Get time-saved metrics.
   */
  async getTimeSavedMetrics(): Promise<{ totalMinutesSaved: number; patternsTracked: number; patternsAtAutopilotOrAbove: number; automationRate: number }> {
    const { data } = await this.db
      .from('task_transitions')
      .select('current_stage, time_saved_minutes')
      .eq('workspace_id', this.workspaceId)
      .eq('active', 1);

    if (!data || data.length === 0) {
      return { totalMinutesSaved: 0, patternsTracked: 0, patternsAtAutopilotOrAbove: 0, automationRate: 0 };
    }

    const total = data.reduce((s, r) => s + ((r.time_saved_minutes as number) || 0), 0);
    const atAutopilot = data.filter((r) => (r.current_stage as number) >= 4).length;
    const atDraft = data.filter((r) => (r.current_stage as number) >= 3).length;

    return {
      totalMinutesSaved: total,
      patternsTracked: data.length,
      patternsAtAutopilotOrAbove: atAutopilot,
      automationRate: data.length > 0 ? atDraft / data.length : 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async matchToPattern(title: string, toolsUsed: string[]): Promise<string | null> {
    const { data: patterns } = await this.db
      .from('task_patterns')
      .select('id, title_keywords, tool_fingerprint')
      .eq('workspace_id', this.workspaceId);

    if (!patterns || patterns.length === 0) return null;

    const taskKeywords = tokenize(title);
    let bestId: string | null = null;
    let bestScore = 0;

    for (const p of patterns) {
      const keywords = parseJson<string[]>(p.title_keywords, []);
      const tools = parseJson<string[]>(p.tool_fingerprint, []);

      const titleSim = jaccard(taskKeywords, keywords);
      const toolSim = jaccard(toolsUsed, tools);
      const score = 0.6 * titleSim + 0.4 * toolSim;

      if (score >= MATCH_THRESHOLD && score > bestScore) {
        bestScore = score;
        bestId = p.id as string;
      }
    }

    return bestId;
  }

  private async getOrCreateTransition(patternId: string): Promise<string> {
    const { data: existing } = await this.db
      .from('task_transitions')
      .select('id')
      .eq('pattern_id', patternId)
      .eq('workspace_id', this.workspaceId)
      .eq('active', 1)
      .single();

    if (existing) return existing.id as string;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.from('task_transitions').insert({
      id, workspace_id: this.workspaceId, pattern_id: patternId,
      current_stage: 1,
      stage_history: JSON.stringify([{ stage: 1, entered_at: now, reason: 'initial' }]),
      active: 1, created_at: now, updated_at: now,
    });
    return id;
  }

  private async evaluateProgression(
    transitionId: string,
    outcome: { success: boolean; humanEdited: boolean; humanRejected: boolean; correctionApplied: boolean },
  ): Promise<void> {
    const { data: t } = await this.db.from('task_transitions').select('*').eq('id', transitionId).single();
    if (!t) return;

    const stage = t.current_stage as number as TransitionStage;
    const total = ((t.total_instances as number) || 0) + 1;
    const successful = ((t.successful_instances as number) || 0) + (outcome.success ? 1 : 0);
    const corrections = ((t.correction_count as number) || 0) + (outcome.correctionApplied ? 1 : 0);

    const currentEditRate = (t.human_edit_rate as number) || 1.0;
    const newEditRate = 0.2 * (outcome.humanEdited ? 1 : 0) + 0.8 * currentEditRate;
    const successRate = total > 0 ? successful / total : 0;
    const confidence = Math.min(1, successRate * 0.4 + (1 - newEditRate) * 0.3 + (1 - corrections / Math.max(total, 1)) * 0.3);

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      total_instances: total, successful_instances: successful,
      correction_count: corrections,
      human_edit_rate: Math.round(newEditRate * 1000) / 1000,
      confidence_score: Math.round(confidence * 1000) / 1000,
      updated_at: now,
    };

    // Check demotion
    if (stage > 1 && (outcome.humanRejected || (total >= 10 && corrections >= 3))) {
      const newStage = Math.max(1, stage - 1);
      const history = parseJson<Array<Record<string, unknown>>>(t.stage_history, []);
      history.push({ stage, exited_at: now, reason: outcome.humanRejected ? 'rejected' : 'corrections' });
      updates.current_stage = newStage;
      updates.stage_history = JSON.stringify(history);
      updates.last_demoted_at = now;
      updates.correction_count = 0;
      logger.info({ transitionId, from: stage, to: newStage }, 'Transition demoted');
    }
    // Check promotion
    else if (stage < 5) {
      const threshold = PROMOTION_THRESHOLDS[stage];
      if (threshold && total >= threshold.minInstances && successRate >= threshold.minSuccessRate
        && newEditRate <= threshold.maxEditRate && corrections <= threshold.maxCorrections) {
        const newStage = stage + 1;
        const history = parseJson<Array<Record<string, unknown>>>(t.stage_history, []);
        history.push({ stage, exited_at: now, reason: 'promoted' });
        updates.current_stage = newStage;
        updates.stage_history = JSON.stringify(history);
        updates.last_promoted_at = now;
        updates.total_instances = 0;
        updates.successful_instances = 0;
        updates.correction_count = 0;
        logger.info({ transitionId, from: stage, to: newStage }, 'Transition promoted');
      }
    }

    await this.db.from('task_transitions').update(updates).eq('id', transitionId);
  }
}
