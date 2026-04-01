import type { MetricName, SetPoint } from './types.js';
import { DEFAULT_SET_POINTS } from './types.js';

/**
 * Initialize set points with defaults.
 */
export function initializeSetPoints(): SetPoint[] {
  return Object.entries(DEFAULT_SET_POINTS).map(([metric, defaults]) => ({
    metric: metric as MetricName,
    target: defaults.target,
    tolerance: defaults.tolerance,
    current: defaults.target, // start at target
    errorSignal: 0,
    deviationMagnitude: 0,
    adaptationRate: defaults.adaptationRate,
  }));
}

/**
 * Update a set point with a new current value.
 * Computes error signal and deviation magnitude.
 */
export function updateSetPoint(sp: SetPoint, currentValue: number): SetPoint {
  const errorSignal = currentValue - sp.target;
  const deviationMagnitude = sp.target !== 0
    ? Math.min(1, Math.abs(errorSignal) / Math.abs(sp.target))
    : Math.min(1, Math.abs(errorSignal));

  return {
    ...sp,
    current: currentValue,
    errorSignal,
    deviationMagnitude,
  };
}

/**
 * Adapt a set point when deviation has been persistent.
 * Shifts target toward current value by adaptationRate.
 * This is allostasis: the "new normal."
 */
export function adaptSetPoint(sp: SetPoint, persistentDeviation: boolean): SetPoint {
  if (!persistentDeviation) return sp;

  // Shift target toward current by adaptation rate
  const shift = (sp.current - sp.target) * sp.adaptationRate;
  const newTarget = sp.target + shift;

  return {
    ...sp,
    target: newTarget,
    errorSignal: sp.current - newTarget,
    deviationMagnitude: newTarget !== 0
      ? Math.min(1, Math.abs(sp.current - newTarget) / Math.abs(newTarget))
      : Math.min(1, Math.abs(sp.current - newTarget)),
  };
}
