/**
 * Kairos — Temporal Opportunity Detection (Greek)
 *
 * Not chronos (clock time) but kairos (the opportune moment).
 * A lead follow-up at the right moment closes the deal.
 * A content post at the right moment goes viral.
 *
 * Kairos wraps existing ProactiveSignals with temporal awareness:
 * how urgent is the opportunity, and how fast does it decay?
 */

import type { KairosSignal, KairosUrgency, KairosGoal } from './types.js';

// ============================================================================
// MINIMAL SIGNAL TYPE (compatible with both local and cloud)
// ============================================================================

/** Minimal proactive signal interface (works with both codebases). */
export interface ProactiveSignalLike {
  source: string;
  priority: number;
  description: string;
  context: Record<string, unknown>;
}

// ============================================================================
// KAIROS EVALUATION
// ============================================================================

/**
 * Enrich proactive signals with temporal urgency.
 *
 * Composes with the existing signal evaluator — doesn't replace it.
 * Takes the raw signals + active goals with deadlines and adds
 * urgency, time windows, and decay rates.
 */
export function evaluateKairos(
  signals: ProactiveSignalLike[],
  goals: KairosGoal[],
  now: Date = new Date(),
): KairosSignal[] {
  const kairosSignals: KairosSignal[] = [];
  const nowMs = now.getTime();

  // Enrich each signal with temporal context
  for (const signal of signals) {
    const kairos = enrichWithKairos(signal, goals, nowMs);
    kairosSignals.push(kairos);
  }

  // Add goal-deadline signals that might not have been in the base signals
  for (const goal of goals) {
    if (goal.status !== 'active' || !goal.dueDate) continue;
    const deadlineMs = new Date(goal.dueDate).getTime();
    const daysRemaining = (deadlineMs - nowMs) / (24 * 60 * 60 * 1000);

    if (daysRemaining <= 0) continue; // past due, different concern

    const progress = goal.targetValue
      ? goal.currentValue / goal.targetValue
      : 0;

    // Only generate kairos signals for goals that need attention
    if (progress >= 0.8) continue; // on track

    // Check if this goal is already covered by a base signal
    const alreadyCovered = signals.some(s =>
      s.source === 'goal_shortfall' &&
      (s.context as Record<string, unknown>).goalId === goal.id,
    );

    if (!alreadyCovered && daysRemaining <= 14) {
      const urgency = getDeadlineUrgency(daysRemaining);
      kairosSignals.push({
        source: 'goal_deadline',
        priority: urgency === 'now_or_never' ? 1 : urgency === 'time_sensitive' ? 2 : 3,
        description: `Goal "${goal.title}" at ${Math.round(progress * 100)}% with ${Math.round(daysRemaining)} days remaining`,
        context: { goalId: goal.id, progress, daysRemaining },
        urgency,
        windowOpenAt: now.toISOString(),
        windowCloseAt: goal.dueDate,
        decayRate: 1 / Math.max(1, daysRemaining * 24),
      });
    }
  }

  // Sort by decay rate (highest first = most urgent)
  kairosSignals.sort((a, b) => b.decayRate - a.decayRate);

  return kairosSignals;
}

// ============================================================================
// INTERNAL
// ============================================================================

function enrichWithKairos(
  signal: ProactiveSignalLike,
  goals: KairosGoal[],
  nowMs: number,
): KairosSignal {
  const ctx = signal.context as Record<string, unknown>;

  // Determine urgency from signal source
  let urgency: KairosUrgency = 'anytime';
  let windowCloseAt: string | null = null;
  let decayRate = 0.01; // default: very slow decay

  if (signal.source === 'goal_shortfall') {
    const goalId = ctx.goalId as string | undefined;
    const goal = goalId ? goals.find(g => g.id === goalId) : undefined;
    if (goal?.dueDate) {
      const daysRemaining = (new Date(goal.dueDate).getTime() - nowMs) / (24 * 60 * 60 * 1000);
      urgency = getDeadlineUrgency(daysRemaining);
      windowCloseAt = goal.dueDate;
      decayRate = 1 / Math.max(1, daysRemaining * 24);
    }
  } else if (signal.source === 'stale_leads') {
    urgency = 'optimal_window';
    decayRate = 0.05; // moderate decay: leads cool off
  } else if (signal.source === 'failed_pattern') {
    urgency = 'time_sensitive';
    decayRate = 0.03; // recurring failures are persistent
  } else if (signal.source === 'idle_agent') {
    urgency = 'anytime';
    decayRate = 0.01; // idle agents can wait
  }

  return {
    source: signal.source,
    priority: signal.priority,
    description: signal.description,
    context: signal.context,
    urgency,
    windowOpenAt: new Date(nowMs).toISOString(),
    windowCloseAt,
    decayRate,
  };
}

function getDeadlineUrgency(daysRemaining: number): KairosUrgency {
  if (daysRemaining <= 3) return 'now_or_never';
  if (daysRemaining <= 7) return 'time_sensitive';
  if (daysRemaining <= 14) return 'optimal_window';
  return 'anytime';
}
