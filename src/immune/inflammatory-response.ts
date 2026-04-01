/**
 * Inflammatory Response — Escalation and cooldown logic
 * Manages system alert level based on recent threat activity.
 */

import type { AlertLevel, InflammatoryState } from './types.js';

const ALERT_LEVELS: AlertLevel[] = ['normal', 'elevated', 'high', 'critical', 'quarantine'];

/**
 * Compute the appropriate alert level based on recent threat activity.
 * - 0 threats in last hour -> normal
 * - 1-2 threats -> elevated
 * - 3-4 threats -> high
 * - 5+ threats -> critical
 * - 3+ consecutive threats -> quarantine
 */
export function computeAlertLevel(
  recentThreats: number,
  consecutiveThreats: number,
  currentLevel: AlertLevel,
): AlertLevel {
  // Consecutive threats override: quarantine
  if (consecutiveThreats >= 3) return 'quarantine';

  let proposed: AlertLevel;
  if (recentThreats === 0) proposed = 'normal';
  else if (recentThreats <= 2) proposed = 'elevated';
  else if (recentThreats <= 4) proposed = 'high';
  else proposed = 'critical';

  // Only escalate, never de-escalate instantly (must go through cooldown)
  if (shouldEscalate(currentLevel, proposed)) {
    return proposed;
  }

  return currentLevel;
}

/**
 * Determine if a level change is an escalation.
 * Returns true only if proposed is higher than current.
 */
export function shouldEscalate(current: AlertLevel, proposed: AlertLevel): boolean {
  return ALERT_LEVELS.indexOf(proposed) > ALERT_LEVELS.indexOf(current);
}

/**
 * Compute cooldown duration in milliseconds for a given alert level.
 * Higher levels require longer cooldown before de-escalation.
 */
export function computeCooldown(level: AlertLevel): number {
  switch (level) {
    case 'normal': return 0;
    case 'elevated': return 5 * 60 * 1000;      // 5 minutes
    case 'high': return 15 * 60 * 1000;          // 15 minutes
    case 'critical': return 60 * 60 * 1000;      // 1 hour
    case 'quarantine': return 4 * 60 * 60 * 1000; // 4 hours
  }
}

/**
 * Attempt to de-escalate the inflammatory state if cooldown has passed.
 * Returns the updated state with potentially lowered alert level.
 */
export function tryDeescalate(state: InflammatoryState, now: number): InflammatoryState {
  if (state.alertLevel === 'normal') return state;

  // Cannot de-escalate during cooldown
  if (state.cooldownUntil && now < state.cooldownUntil) return state;

  // De-escalate one level
  const currentIdx = ALERT_LEVELS.indexOf(state.alertLevel);
  const newLevel = ALERT_LEVELS[currentIdx - 1];
  const cooldown = computeCooldown(newLevel);

  return {
    ...state,
    alertLevel: newLevel,
    cooldownUntil: cooldown > 0 ? now + cooldown : null,
  };
}

/**
 * Create an initial inflammatory state.
 */
export function createInitialInflammatoryState(): InflammatoryState {
  return {
    alertLevel: 'normal',
    recentThreats: 0,
    consecutiveThreats: 0,
    escalatedAt: null,
    cooldownUntil: null,
  };
}
