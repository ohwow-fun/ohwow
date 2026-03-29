/**
 * Not everything needs to be seen now. Timing is kindness.
 */

import type { NotificationFilterInput, NotificationDecision } from './types.js';

const DAILY_BUDGET = 20;
const BATCH_DELAY_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Decide how to handle pending notifications based on the user's bio state.
 *
 * Rules (in priority order):
 *   1. Boundary active → suppress (unless critical notifications exist)
 *   2. Stressed → critical only
 *   3. Trough energy → batch with 30 min delay
 *   4. Budget exhausted (>20 today) → batch remaining
 *   5. Calm + peak → send all
 */
export function filterNotification(
  input: NotificationFilterInput
): NotificationDecision {
  const { bioState, pendingNotifications, criticalCount } = input;

  // Rule 1: Boundary active
  if (bioState.boundaryActive) {
    if (criticalCount > 0) {
      return {
        action: 'critical_only',
        reason:
          'Outside work hours. Only ' +
          criticalCount +
          ' critical notification' +
          (criticalCount === 1 ? '' : 's') +
          ' will come through.',
      };
    }
    return {
      action: 'suppress',
      reason: 'Outside work hours. Notifications held until your next work window.',
    };
  }

  // Rule 2: Stressed
  if (bioState.stressLevel === 'stressed') {
    return {
      action: 'critical_only',
      reason:
        'High stress detected. Holding non-critical notifications to reduce cognitive load.',
    };
  }

  // Rule 3: Trough energy
  if (bioState.energyWave === 'trough') {
    return {
      action: 'batch',
      reason: 'Low energy phase. Batching ' + pendingNotifications + ' notifications for later.',
      delayMs: BATCH_DELAY_MS,
    };
  }

  // Rule 4: Budget exhausted
  if (bioState.notificationBudget <= 0 || pendingNotifications > DAILY_BUDGET) {
    return {
      action: 'batch',
      reason: 'Daily notification budget reached. Batching the rest.',
      delayMs: BATCH_DELAY_MS,
    };
  }

  // Rule 5: Good state — send everything
  return {
    action: 'send_all',
    reason: 'Good energy and focus. Delivering all ' + pendingNotifications + ' notifications.',
  };
}
