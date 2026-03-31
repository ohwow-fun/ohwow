/**
 * Task Router (E14) — Evolving Agent Selection with Thompson Sampling
 *
 * Routes tasks to the best-fit agent using a multi-signal scoring model
 * that learns from outcomes. Uses Thompson Sampling for exploration/exploitation.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { AgentScore, RoutingDecision, TaskRoutingContext } from './types.js';
import { proportionTest, wilsonInterval } from '../stats/significance.js';
import { logger } from '../logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const SIGNAL_WEIGHTS = {
  capabilityMatch: 0.35,
  historicalSuccess: 0.30,
  workloadPenalty: 0.15,
  costEfficiency: 0.10,
  explorationBonus: 0.10,
};

const MIN_ATTEMPTS_FOR_HISTORY = 3;

const TASK_TYPE_PATTERNS: Array<{ type: string; patterns: RegExp[] }> = [
  { type: 'email', patterns: [/email/i, /send\s+message/i, /newsletter/i, /outreach/i] },
  { type: 'content', patterns: [/write/i, /blog/i, /post/i, /article/i, /content/i, /copy/i] },
  { type: 'research', patterns: [/research/i, /find/i, /look\s+up/i, /analyze/i, /report/i] },
  { type: 'data', patterns: [/data/i, /csv/i, /spreadsheet/i, /metrics/i, /dashboard/i] },
  { type: 'social', patterns: [/social/i, /twitter/i, /linkedin/i, /instagram/i, /tiktok/i] },
  { type: 'scheduling', patterns: [/schedule/i, /calendar/i, /meeting/i, /book/i, /appointment/i] },
  { type: 'crm', patterns: [/contact/i, /lead/i, /client/i, /customer/i, /crm/i, /pipeline/i] },
  { type: 'support', patterns: [/support/i, /ticket/i, /help/i, /issue/i, /complaint/i] },
];

// ============================================================================
// TASK TYPE CLASSIFICATION
// ============================================================================

export function classifyTaskType(context: TaskRoutingContext): string {
  if (context.taskType) return context.taskType;
  const text = `${context.title} ${context.description || ''} ${context.input || ''}`;
  for (const { type, patterns } of TASK_TYPE_PATTERNS) {
    if (patterns.some((p) => p.test(text))) return type;
  }
  return 'general';
}

// ============================================================================
// THOMPSON SAMPLING
// ============================================================================

function sampleBeta(successes: number, failures: number): number {
  const alpha = successes + 1;
  const beta = failures + 1;
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

function sampleGamma(shape: number): number {
  if (shape < 1) {
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normalRandom();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalRandom(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ============================================================================
// SCORING
// ============================================================================

interface AgentCandidate {
  id: string;
  name: string;
  capabilities: string[];
  specialties: string[];
}

interface RoutingStats {
  successes: number;
  attempts: number;
  successRate: number;
  avgTruthScore: number;
  avgCostCents: number;
}

function scoreCapabilityMatch(agent: AgentCandidate, taskType: string): number {
  const capabilityMap: Record<string, string[]> = {
    email: ['email_management', 'communication'],
    content: ['content_writing', 'content_creation'],
    research: ['research', 'data_analysis', 'web_research'],
    data: ['data_analysis', 'reporting'],
    social: ['social_media', 'content_creation'],
    scheduling: ['scheduling', 'calendar'],
    crm: ['crm', 'customer_management', 'sales'],
    support: ['customer_support', 'support'],
    general: [],
  };

  const relevantCapabilities = capabilityMap[taskType] || [];
  if (relevantCapabilities.length === 0) return 0.5;

  const matched = relevantCapabilities.filter((cap) => agent.capabilities.includes(cap));
  const specialtyMatch = agent.specialties.some((s) =>
    relevantCapabilities.some((cap) => s.toLowerCase().includes(cap.toLowerCase()))
  );

  const capScore = matched.length / relevantCapabilities.length;
  const specialtyBonus = specialtyMatch ? 0.2 : 0;
  return Math.min(1, capScore + specialtyBonus);
}

function scoreHistoricalSuccess(
  stats: RoutingStats | null,
  useThompsonSampling: boolean
): { score: number; explorationUsed: boolean } {
  if (!stats || stats.attempts < MIN_ATTEMPTS_FOR_HISTORY) {
    if (useThompsonSampling) {
      return {
        score: sampleBeta(stats?.successes || 0, (stats?.attempts || 0) - (stats?.successes || 0)),
        explorationUsed: true,
      };
    }
    return { score: 0.5, explorationUsed: false };
  }

  if (useThompsonSampling) {
    const failures = stats.attempts - stats.successes;
    return { score: sampleBeta(stats.successes, failures), explorationUsed: true };
  }

  // Use Wilson interval for a conservative point estimate
  // instead of raw success rate (better with small samples)
  const interval = wilsonInterval(stats.successes, stats.attempts);
  return { score: interval.center, explorationUsed: false };
}

function scoreWorkload(status: string, activeTasks: number): number {
  if (status === 'busy') return 0.2;
  if (status === 'needs_approval') return 0.5;
  return Math.max(0, 1 - activeTasks * 0.1);
}

function scoreCostEfficiency(avgCostCents: number, maxCostCents: number): number {
  if (maxCostCents === 0) return 0.5;
  return 1 - (avgCostCents / maxCostCents);
}

// ============================================================================
// TASK ROUTER
// ============================================================================

export class TaskRouter {
  constructor(
    private db: DatabaseAdapter,
    private workspaceId: string
  ) {}

  async route(
    context: TaskRoutingContext,
    candidates: AgentCandidate[],
    options?: { useThompsonSampling?: boolean }
  ): Promise<RoutingDecision> {
    const useThompson = options?.useThompsonSampling ?? true;
    const taskType = classifyTaskType(context);

    if (candidates.length === 0) {
      throw new Error('No candidate agents available for routing');
    }

    if (candidates.length === 1) {
      const card = candidates[0];
      return {
        selectedAgentId: card.id,
        scores: [{
          agentId: card.id, agentName: card.name, totalScore: 1,
          signals: { capabilityMatch: 1, historicalSuccess: 1, workloadPenalty: 0, costEfficiency: 1, explorationBonus: 0 },
          selected: true,
        }],
        reason: 'Only one candidate agent available',
        explorationUsed: false,
      };
    }

    const [statsMap, agentStatuses] = await Promise.all([
      this.getRoutingStats(candidates.map((c) => c.id), taskType),
      this.getAgentStatuses(candidates.map((c) => c.id)),
    ]);

    const allCosts = [...statsMap.values()].map((s) => s.avgCostCents).filter((c) => c > 0);
    const maxCost = allCosts.length > 0 ? Math.max(...allCosts) : 1;

    let explorationUsed = false;
    const scores: AgentScore[] = candidates.map((agent) => {
      const stats = statsMap.get(agent.id) || null;
      const status = agentStatuses.get(agent.id) || { status: 'idle', activeTasks: 0 };

      const capabilityMatch = scoreCapabilityMatch(agent, taskType);
      const historical = scoreHistoricalSuccess(stats, useThompson);
      const workloadPenalty = 1 - scoreWorkload(status.status, status.activeTasks);
      const costEfficiency = scoreCostEfficiency(stats?.avgCostCents || 0, maxCost);

      if (historical.explorationUsed) explorationUsed = true;

      const totalScore =
        capabilityMatch * SIGNAL_WEIGHTS.capabilityMatch +
        historical.score * SIGNAL_WEIGHTS.historicalSuccess +
        (1 - workloadPenalty) * SIGNAL_WEIGHTS.workloadPenalty +
        costEfficiency * SIGNAL_WEIGHTS.costEfficiency +
        (historical.explorationUsed ? 0.1 : 0) * SIGNAL_WEIGHTS.explorationBonus;

      return {
        agentId: agent.id, agentName: agent.name, totalScore,
        signals: {
          capabilityMatch, historicalSuccess: historical.score,
          workloadPenalty, costEfficiency,
          explorationBonus: historical.explorationUsed ? 0.1 : 0,
        },
        selected: false,
      };
    });

    scores.sort((a, b) => b.totalScore - a.totalScore);
    scores[0].selected = true;

    // When not using Thompson Sampling (pure exploitation mode),
    // require statistical significance before committing to the top agent.
    // If the top two agents aren't significantly different, mark as exploration
    // so the system keeps gathering data rather than prematurely converging.
    let significanceNote = '';
    if (!useThompson && scores.length >= 2) {
      const topId = scores[0].agentId;
      const runnerId = scores[1].agentId;
      const topStats = statsMap.get(topId);
      const runnerStats = statsMap.get(runnerId);
      if (topStats && runnerStats && topStats.attempts >= 5 && runnerStats.attempts >= 5) {
        const test = proportionTest(
          topStats.successes, topStats.attempts,
          runnerStats.successes, runnerStats.attempts,
        );
        if (!test.significant) {
          explorationUsed = true;
          significanceNote = ` (p=${test.pValue.toFixed(3)}, not yet significant)`;
        }
      }
    }

    logger.info(
      { taskType, selectedAgent: scores[0].agentName, score: scores[0].totalScore.toFixed(3), explorationUsed },
      `[TaskRouter] Routing decision made${significanceNote}`,
    );

    return {
      selectedAgentId: scores[0].agentId,
      scores,
      reason: `Best match for ${taskType} task: ${scores[0].agentName} (score: ${scores[0].totalScore.toFixed(3)})`,
      explorationUsed,
    };
  }

  async recordOutcome(agentId: string, taskType: string, success: boolean, truthScore?: number, costCents?: number): Promise<void> {
    try {
      const { data: existing } = await this.db
        .from('agent_workforce_routing_stats')
        .select('*')
        .eq('workspace_id', this.workspaceId)
        .eq('agent_id', agentId)
        .eq('task_type', taskType)
        .single();

      if (existing) {
        const row = existing as Record<string, unknown>;
        const newAttempts = (row.attempts as number) + 1;
        const newSuccesses = (row.successes as number) + (success ? 1 : 0);
        const oldAvgTruth = (row.avg_truth_score as number) || 0;
        const newAvgTruth = truthScore !== undefined ? oldAvgTruth + (truthScore - oldAvgTruth) / newAttempts : oldAvgTruth;
        const oldAvgCost = (row.avg_cost_cents as number) || 0;
        const newAvgCost = costCents !== undefined ? oldAvgCost + (costCents - oldAvgCost) / newAttempts : oldAvgCost;

        await this.db
          .from('agent_workforce_routing_stats')
          .update({
            attempts: newAttempts, successes: newSuccesses,
            success_rate: newSuccesses / newAttempts,
            avg_truth_score: newAvgTruth, avg_cost_cents: newAvgCost,
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id as string);
      } else {
        await this.db
          .from('agent_workforce_routing_stats')
          .insert({
            workspace_id: this.workspaceId, agent_id: agentId, task_type: taskType,
            attempts: 1, successes: success ? 1 : 0, success_rate: success ? 1 : 0,
            avg_truth_score: truthScore ?? 0, avg_cost_cents: costCents ?? 0,
          });
      }
    } catch (err) {
      logger.error({ err, agentId, taskType }, '[TaskRouter] Couldn\'t record routing outcome');
    }
  }

  private async getRoutingStats(agentIds: string[], taskType: string): Promise<Map<string, RoutingStats>> {
    const result = new Map<string, RoutingStats>();
    try {
      const { data } = await this.db
        .from('agent_workforce_routing_stats')
        .select('agent_id, successes, attempts, success_rate, avg_truth_score, avg_cost_cents')
        .eq('workspace_id', this.workspaceId)
        .eq('task_type', taskType)
        .in('agent_id', agentIds);

      if (data) {
        for (const row of data) {
          const r = row as Record<string, unknown>;
          const attempts = r.attempts as number;
          const successes = r.successes as number;
          result.set(r.agent_id as string, {
            successes, attempts,
            successRate: attempts > 0 ? successes / attempts : 0,
            avgTruthScore: (r.avg_truth_score as number) || 0,
            avgCostCents: (r.avg_cost_cents as number) || 0,
          });
        }
      }
    } catch { /* no stats table yet */ }
    return result;
  }

  private async getAgentStatuses(agentIds: string[]): Promise<Map<string, { status: string; activeTasks: number }>> {
    const result = new Map<string, { status: string; activeTasks: number }>();
    try {
      const [{ data: agents }, { data: taskCounts }] = await Promise.all([
        this.db.from('agent_workforce_agents').select('id, status').in('id', agentIds),
        this.db.from('agent_workforce_tasks').select('agent_id').in('agent_id', agentIds).in('status', ['in_progress', 'pending']),
      ]);

      const taskCountMap = new Map<string, number>();
      if (taskCounts) {
        for (const row of taskCounts) {
          const aid = (row as Record<string, unknown>).agent_id as string;
          taskCountMap.set(aid, (taskCountMap.get(aid) || 0) + 1);
        }
      }

      if (agents) {
        for (const agent of agents) {
          const a = agent as Record<string, unknown>;
          result.set(a.id as string, {
            status: (a.status as string) || 'idle',
            activeTasks: taskCountMap.get(a.id as string) || 0,
          });
        }
      }
    } catch { /* return empty */ }
    return result;
  }
}

export function createTaskRouter(db: DatabaseAdapter, workspaceId: string): TaskRouter {
  return new TaskRouter(db, workspaceId);
}
