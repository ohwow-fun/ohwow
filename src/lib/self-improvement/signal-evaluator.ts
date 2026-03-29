/**
 * Signal Evaluator (E21) — Aggregates Workspace Signals
 *
 * Scans workspace state for actionable signals and ranks them
 * by priority. Signals come from goals, contacts, agent status,
 * failed tasks, and discovered processes.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ProactiveSignal } from './types.js';
import { logger } from '../logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_SIGNALS = 10;
const GOAL_PROGRESS_THRESHOLD = 0.5;
const GOAL_DAYS_THRESHOLD = 14;
const CONTACT_STALE_DAYS = 7;
const AGENT_IDLE_DAYS = 5;
const FAILED_PATTERN_THRESHOLD = 3;

// ============================================================================
// SIGNAL EVALUATORS
// ============================================================================

async function evaluateGoalShortfalls(db: DatabaseAdapter, workspaceId: string): Promise<ProactiveSignal[]> {
  const signals: ProactiveSignal[] = [];
  try {
    const { data: goals } = await db
      .from('agent_workforce_goals')
      .select('id, title, target_value, current_value, deadline')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .not('deadline', 'is', null);

    if (!goals) return signals;

    const now = Date.now();
    for (const goal of goals) {
      const g = goal as Record<string, unknown>;
      const deadline = new Date(g.deadline as string).getTime();
      const daysRemaining = (deadline - now) / (24 * 60 * 60 * 1000);
      const target = (g.target_value as number) || 1;
      const current = (g.current_value as number) || 0;
      const progress = current / target;

      if (daysRemaining <= GOAL_DAYS_THRESHOLD && progress < GOAL_PROGRESS_THRESHOLD) {
        signals.push({
          source: 'goal_shortfall',
          priority: 1,
          description: `Goal "${g.title}" is at ${Math.round(progress * 100)}% with ${Math.round(daysRemaining)} days remaining`,
          suggestedTitle: `Accelerate: ${g.title}`,
          suggestedDescription: `Goal at ${Math.round(progress * 100)}% progress with ${Math.round(daysRemaining)} days until deadline. Create action plan to close the gap.`,
          context: { goalId: g.id, progress, daysRemaining },
        });
      }
    }
  } catch { /* non-fatal */ }
  return signals;
}

async function evaluateStaleLeads(db: DatabaseAdapter, workspaceId: string): Promise<ProactiveSignal[]> {
  const signals: ProactiveSignal[] = [];
  try {
    const staleSince = new Date(Date.now() - CONTACT_STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: contacts, count } = await db
      .from('agent_workforce_contacts')
      .select('id, name', { count: 'exact', head: false })
      .eq('workspace_id', workspaceId)
      .lt('last_contacted_at', staleSince)
      .limit(5);

    if (count && count > 0) {
      const names = (contacts ?? []).map((c) => (c as Record<string, unknown>).name as string).slice(0, 3);
      signals.push({
        source: 'stale_leads',
        priority: 2,
        description: `${count} contacts with no activity in ${CONTACT_STALE_DAYS}+ days`,
        suggestedTitle: `Follow up with ${count} stale contacts`,
        suggestedDescription: `${count} contacts haven't been contacted in over ${CONTACT_STALE_DAYS} days. Includes: ${names.join(', ')}${count > 3 ? ` and ${count - 3} more` : ''}.`,
        context: { staleCount: count, sampleNames: names },
      });
    }
  } catch { /* non-fatal */ }
  return signals;
}

async function evaluateFailedPatterns(db: DatabaseAdapter, workspaceId: string): Promise<ProactiveSignal[]> {
  const signals: ProactiveSignal[] = [];
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: failedTasks } = await db
      .from('agent_workforce_tasks')
      .select('title, failure_category, agent_id')
      .eq('workspace_id', workspaceId)
      .eq('status', 'failed')
      .gte('created_at', since);

    if (!failedTasks || failedTasks.length < FAILED_PATTERN_THRESHOLD) return signals;

    const categories = new Map<string, number>();
    for (const task of failedTasks) {
      const cat = ((task as Record<string, unknown>).failure_category as string) || 'unknown';
      categories.set(cat, (categories.get(cat) || 0) + 1);
    }

    for (const [category, count] of categories) {
      if (count >= FAILED_PATTERN_THRESHOLD) {
        signals.push({
          source: 'failed_pattern',
          priority: 4,
          description: `${count} tasks failed with "${category}" in the last 7 days`,
          suggestedTitle: `Diagnose recurring ${category} failures`,
          suggestedDescription: `${count} tasks have failed with the same error category "${category}" in the past week. Investigate root cause and fix.`,
          context: { failureCategory: category, count },
        });
      }
    }
  } catch { /* non-fatal */ }
  return signals;
}

async function evaluateIdleAgents(db: DatabaseAdapter, workspaceId: string): Promise<ProactiveSignal[]> {
  const signals: ProactiveSignal[] = [];
  try {
    const idleSince = new Date(Date.now() - AGENT_IDLE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: agents } = await db
      .from('agent_workforce_agents')
      .select('id, name')
      .eq('workspace_id', workspaceId)
      .eq('status', 'idle');

    if (!agents) return signals;

    for (const agent of agents) {
      const a = agent as Record<string, unknown>;
      const agentId = a.id as string;
      const { count } = await db
        .from('agent_workforce_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .gte('completed_at', idleSince);

      if (count === 0) {
        signals.push({
          source: 'idle_agent',
          priority: 6,
          description: `Agent "${a.name}" has been idle for ${AGENT_IDLE_DAYS}+ days`,
          suggestedTitle: `Assign work to idle agent: ${a.name}`,
          suggestedDescription: `${a.name} has not completed any tasks in ${AGENT_IDLE_DAYS}+ days. Assign from backlog or run training.`,
          suggestedAgentId: agentId,
          context: { agentId, agentName: a.name },
        });
      }
    }
  } catch { /* non-fatal */ }
  return signals;
}

async function evaluateDiscoveredProcesses(db: DatabaseAdapter, workspaceId: string): Promise<ProactiveSignal[]> {
  const signals: ProactiveSignal[] = [];
  try {
    const { data: processes } = await db
      .from('agent_workforce_discovered_processes')
      .select('id, name, description, frequency')
      .eq('workspace_id', workspaceId)
      .eq('status', 'discovered')
      .gte('frequency', 10)
      .order('frequency', { ascending: false })
      .limit(3);

    if (!processes) return signals;

    for (const proc of processes) {
      const p = proc as Record<string, unknown>;
      signals.push({
        source: 'discovered_process',
        priority: 5,
        description: `High-frequency process "${p.name}" could be automated (${p.frequency} occurrences)`,
        suggestedTitle: `Automate: ${p.name}`,
        suggestedDescription: `${p.description || p.name} has been observed ${p.frequency} times. Consider creating an automation workflow.`,
        context: { processId: p.id, processName: p.name, frequency: p.frequency },
      });
    }
  } catch { /* non-fatal */ }
  return signals;
}

// ============================================================================
// MAIN EVALUATOR
// ============================================================================

/**
 * Evaluate all workspace signals and return ranked proactive signals.
 */
/**
 * Optional Global Workspace for live broadcasting of proactive signals
 * (Phase 6: Buddhist Dependent Origination).
 */
interface SignalEvaluatorOptions {
  workspace?: import('../../brain/global-workspace.js').GlobalWorkspace;
}

export async function evaluateSignals(db: DatabaseAdapter, workspaceId: string, options?: SignalEvaluatorOptions): Promise<ProactiveSignal[]> {
  const [goals, leads, failed, idle, processes] = await Promise.all([
    evaluateGoalShortfalls(db, workspaceId),
    evaluateStaleLeads(db, workspaceId),
    evaluateFailedPatterns(db, workspaceId),
    evaluateIdleAgents(db, workspaceId),
    evaluateDiscoveredProcesses(db, workspaceId),
  ]);

  const allSignals = [...goals, ...leads, ...failed, ...idle, ...processes];
  allSignals.sort((a, b) => a.priority - b.priority);

  const result = allSignals.slice(0, MAX_SIGNALS);

  logger.info(
    { workspaceId, totalSignals: allSignals.length, returned: result.length,
      breakdown: { goals: goals.length, leads: leads.length, failed: failed.length, idle: idle.length, processes: processes.length } },
    '[SignalEvaluator] Signal evaluation completed',
  );

  // Phase 6: Broadcast proactive signals to the Global Workspace
  if (options?.workspace && result.length > 0) {
    for (const signal of result.slice(0, 3)) { // top 3 most important
      options.workspace.broadcastSignal(
        `signal-evaluator:${signal.source}`,
        signal.description,
        Math.min(0.9, 1 - (signal.priority / 10)), // higher priority → higher salience
      );
    }
  }

  return result;
}
