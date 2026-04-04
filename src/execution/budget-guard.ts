/**
 * Budget Guard — Hard cost enforcement for external API providers
 *
 * Only enforced when using paid providers (Anthropic, OpenRouter, Claude Code CLI).
 * Local Ollama execution is always free and unlimited.
 *
 * Uses the existing `autonomy_budget` TEXT column on agent_workforce_agents.
 * The column stores a JSON string matching the AutonomyBudget shape.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface AutonomyBudget {
  /** Per-task hard cap in cents. 0 = unlimited. */
  perTaskCents: number;
  /** Daily rolling cap in cents. 0 = unlimited. */
  dailyCents: number;
  /** Monthly rolling cap in cents. 0 = unlimited. */
  monthlyCents: number;
  /** Fraction (0-1) at which a warning is emitted. Default 0.8. */
  warnAt: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  /** If between warnAt and 1.0, this is the highest utilization percentage. */
  warningPct?: number;
}

// ============================================================================
// PARSE
// ============================================================================

/**
 * Parse the autonomy_budget TEXT field into a typed budget.
 * Returns null if the field is empty, null, or invalid JSON.
 */
export function parseBudget(raw: string | null | undefined): AutonomyBudget | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const perTaskCents = typeof parsed.perTaskCents === 'number' ? parsed.perTaskCents : 0;
    const dailyCents = typeof parsed.dailyCents === 'number' ? parsed.dailyCents : 0;
    const monthlyCents = typeof parsed.monthlyCents === 'number' ? parsed.monthlyCents : 0;
    const warnAt = typeof parsed.warnAt === 'number' ? parsed.warnAt : 0.8;

    // All zeros means no enforcement
    if (perTaskCents === 0 && dailyCents === 0 && monthlyCents === 0) return null;

    return { perTaskCents, dailyCents, monthlyCents, warnAt };
  } catch {
    logger.warn({ raw }, '[budget-guard] Failed to parse autonomy_budget');
    return null;
  }
}

// ============================================================================
// PRE-FLIGHT CHECK
// ============================================================================

/**
 * Pre-flight budget check before a task starts.
 * Queries daily and monthly spend from resource_usage_daily.
 * Returns { allowed: false } if any period is at or over budget.
 */
export async function checkPreFlight(
  db: DatabaseAdapter,
  agentId: string,
  workspaceId: string,
  budget: AutonomyBudget,
): Promise<BudgetCheckResult> {
  const warnAt = budget.warnAt > 0 && budget.warnAt < 1 ? budget.warnAt : 0.8;
  let highestUtilization = 0;

  // Check daily budget
  if (budget.dailyCents > 0) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const { data } = await db
      .from('resource_usage_daily')
      .select('total_cost_cents')
      .eq('workspace_id', workspaceId)
      .eq('date', today)
      .maybeSingle();

    const dailySpent = (data as { total_cost_cents: number } | null)?.total_cost_cents ?? 0;
    const dailyUtil = dailySpent / budget.dailyCents;
    highestUtilization = Math.max(highestUtilization, dailyUtil);

    if (dailySpent >= budget.dailyCents) {
      return {
        allowed: false,
        reason: `Daily budget exhausted: ${dailySpent}c spent of ${budget.dailyCents}c limit`,
      };
    }
  }

  // Check monthly budget
  if (budget.monthlyCents > 0) {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const monthEnd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-31`;

    // Sum all daily entries for this month
    const { data: monthRows } = await db
      .from('resource_usage_daily')
      .select('total_cost_cents')
      .eq('workspace_id', workspaceId)
      .gte('date', monthStart)
      .lte('date', monthEnd);

    const monthlySpent = (monthRows as Array<{ total_cost_cents: number }> | null)
      ?.reduce((sum, row) => sum + (row.total_cost_cents || 0), 0) ?? 0;
    const monthlyUtil = monthlySpent / budget.monthlyCents;
    highestUtilization = Math.max(highestUtilization, monthlyUtil);

    if (monthlySpent >= budget.monthlyCents) {
      return {
        allowed: false,
        reason: `Monthly budget exhausted: ${monthlySpent}c spent of ${budget.monthlyCents}c limit`,
      };
    }
  }

  const result: BudgetCheckResult = { allowed: true };
  if (highestUtilization >= warnAt) {
    result.warningPct = Math.round(highestUtilization * 100);
  }
  return result;
}

// ============================================================================
// MID-LOOP CHECK
// ============================================================================

/**
 * Synchronous mid-loop check during task execution.
 * Only checks the per-task cap (daily/monthly are pre-flight concerns).
 */
export function checkMidLoop(
  runningCostCents: number,
  budget: AutonomyBudget,
): BudgetCheckResult {
  if (budget.perTaskCents > 0 && runningCostCents >= budget.perTaskCents) {
    return {
      allowed: false,
      reason: `Per-task budget exceeded: ${runningCostCents}c of ${budget.perTaskCents}c limit`,
    };
  }
  return { allowed: true };
}

// ============================================================================
// PROVIDER CHECK
// ============================================================================

/**
 * Returns true when the execution path costs money.
 * Ollama (local) is always free. Everything else is paid.
 */
export function isExternalProvider(useOllama: boolean): boolean {
  return !useOllama;
}

// ============================================================================
// DAILY RESOURCE UPSERT
// ============================================================================

/**
 * Upsert the daily resource usage row for cost tracking.
 * Called after each task completion to keep the daily/monthly totals current.
 */
export async function upsertDailyResourceUsage(
  db: DatabaseAdapter,
  workspaceId: string,
  tokens: number,
  costCents: number,
): Promise<void> {
  if (costCents === 0 && tokens === 0) return;

  const today = new Date().toISOString().slice(0, 10);
  try {
    // Try update first (most common path)
    const { data: existing } = await db
      .from('resource_usage_daily')
      .select('id, total_tasks, total_tokens, total_cost_cents')
      .eq('workspace_id', workspaceId)
      .eq('date', today)
      .maybeSingle();

    if (existing) {
      const row = existing as { id: string; total_tasks: number; total_tokens: number; total_cost_cents: number };
      await db.from('resource_usage_daily').update({
        total_tasks: row.total_tasks + 1,
        total_tokens: row.total_tokens + tokens,
        total_cost_cents: row.total_cost_cents + costCents,
      }).eq('id', row.id);
    } else {
      await db.from('resource_usage_daily').insert({
        workspace_id: workspaceId,
        date: today,
        total_tasks: 1,
        total_tokens: tokens,
        total_cost_cents: costCents,
      });
    }
  } catch (err) {
    logger.warn({ err, workspaceId, costCents }, '[budget-guard] Failed to upsert daily resource usage');
  }
}
