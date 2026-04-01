import type { SetPoint, CorrectiveAction } from './types.js';

/**
 * Compute corrective action for a set point deviation.
 * Returns 'none' if within tolerance.
 */
export function computeCorrectiveAction(sp: SetPoint): CorrectiveAction {
  // Within tolerance — no action
  if (sp.deviationMagnitude <= sp.tolerance) {
    return { type: 'none', metric: sp.metric, reason: 'Within tolerance', urgency: 0 };
  }

  const urgency = Math.min(1, (sp.deviationMagnitude - sp.tolerance) / (1 - sp.tolerance));

  switch (sp.metric) {
    case 'memory_count':
      return sp.errorSignal > 0
        ? { type: 'compress_memory', metric: sp.metric, reason: `Memory count ${sp.current} exceeds target ${sp.target}`, urgency }
        : { type: 'none', metric: sp.metric, reason: 'Memory count below target (acceptable)', urgency: 0 };

    case 'cost_per_day':
      return sp.errorSignal > 0
        ? { type: 'throttle', metric: sp.metric, reason: `Daily cost ${sp.current} exceeds target ${sp.target}`, urgency }
        : { type: 'none', metric: sp.metric, reason: 'Cost below target (acceptable)', urgency: 0 };

    case 'success_rate':
      return sp.errorSignal < 0
        ? { type: 'adjust_routing', metric: sp.metric, reason: `Success rate ${(sp.current * 100).toFixed(0)}% below target ${(sp.target * 100).toFixed(0)}%`, urgency }
        : { type: 'none', metric: sp.metric, reason: 'Success rate above target', urgency: 0 };

    case 'error_rate':
      return sp.errorSignal > 0
        ? { type: 'throttle', metric: sp.metric, reason: `Error rate ${(sp.current * 100).toFixed(0)}% exceeds target ${(sp.target * 100).toFixed(0)}%`, urgency }
        : { type: 'none', metric: sp.metric, reason: 'Error rate within target', urgency: 0 };

    case 'utilization':
      if (sp.errorSignal > 0) {
        return { type: 'alert_human', metric: sp.metric, reason: `Utilization ${(sp.current * 100).toFixed(0)}% exceeds capacity`, urgency };
      }
      return { type: 'none', metric: sp.metric, reason: 'Utilization within range', urgency: 0 };

    case 'sleep_debt':
      return sp.errorSignal > 0
        ? { type: 'compress_memory', metric: sp.metric, reason: `Sleep debt ${sp.current.toFixed(2)} needs consolidation`, urgency }
        : { type: 'none', metric: sp.metric, reason: 'Sleep debt within target', urgency: 0 };

    default:
      return { type: 'none', metric: sp.metric, reason: 'No corrective action mapped', urgency: 0 };
  }
}

/**
 * Compute all corrective actions from a set of set points.
 * Returns only actions that are not 'none', sorted by urgency.
 */
export function computeAllCorrectiveActions(setPoints: SetPoint[]): CorrectiveAction[] {
  return setPoints
    .map(computeCorrectiveAction)
    .filter(a => a.type !== 'none')
    .sort((a, b) => b.urgency - a.urgency);
}
