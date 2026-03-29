/**
 * Chrono-Biology — Circadian Rhythm Detection
 *
 * Infers when this human does their best work from timestamps alone.
 * No questions asked. Just observation over 30+ days.
 */

import type { ChronoBioProfile, ChronoBioInput } from './types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Minimum data points for a meaningful profile. */
const MIN_DATA_POINTS = 20;

/** Number of peak/low hours to identify. */
const TOP_N_HOURS = 3;

// ============================================================================
// CHRONO-BIO DETECTION
// ============================================================================

/**
 * Compute a circadian profile from action timestamps.
 *
 * Pure function. No DB access. Deterministic.
 */
export function computeChronoBio(input: ChronoBioInput): ChronoBioProfile {
  const { actionTimestamps } = input;

  if (actionTimestamps.length < MIN_DATA_POINTS) {
    return defaultProfile();
  }

  // Bucket timestamps into 24 hourly bins
  const hourBins = new Array(24).fill(0);
  const dailyFirst: number[] = [];
  const dailyLast: number[] = [];
  const dayOfWeekCounts = new Array(7).fill(0); // 0=Sun

  // Group by day for first/last calculation
  const dayMap = new Map<string, number[]>();

  for (const ts of actionTimestamps) {
    const date = new Date(ts);
    const hour = date.getHours();
    const dayKey = date.toISOString().split('T')[0];
    const dow = date.getDay();

    hourBins[hour]++;
    dayOfWeekCounts[dow]++;

    if (!dayMap.has(dayKey)) dayMap.set(dayKey, []);
    dayMap.get(dayKey)!.push(hour);
  }

  // Compute first/last action hour per day
  for (const hours of dayMap.values()) {
    dailyFirst.push(Math.min(...hours));
    dailyLast.push(Math.max(...hours));
  }

  // Peak hours: top N by activity count
  const sortedHours = hourBins
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count);

  const peakHours = sortedHours.slice(0, TOP_N_HOURS).map(h => h.hour).sort((a, b) => a - b);
  const lowHours = sortedHours.slice(-TOP_N_HOURS).map(h => h.hour).sort((a, b) => a - b);

  // Average first/last action
  const avgFirst = dailyFirst.length > 0
    ? Math.round(dailyFirst.reduce((a, b) => a + b, 0) / dailyFirst.length)
    : 9;
  const avgLast = dailyLast.length > 0
    ? Math.round(dailyLast.reduce((a, b) => a + b, 0) / dailyLast.length)
    : 18;

  // Weekend activity
  const totalActions = actionTimestamps.length;
  const weekendActions = dayOfWeekCounts[0] + dayOfWeekCounts[6]; // Sun + Sat
  const weekendActive = totalActions > 0 ? (weekendActions / totalActions) > 0.1 : false;

  // Confidence scales with data points (logarithmic)
  const confidence = Math.min(0.95, Math.log2(actionTimestamps.length) / 10);

  return {
    peakHours,
    lowHours,
    averageFirstActionHour: avgFirst,
    averageLastActionHour: avgLast,
    weekendActive,
    confidence,
  };
}

/**
 * Estimate current energy state from chronobio profile and current hour.
 */
export function estimateEnergyState(
  profile: ChronoBioProfile,
  currentHour: number,
): 'peak' | 'normal' | 'low' | 'rest' {
  if (currentHour < profile.averageFirstActionHour || currentHour > profile.averageLastActionHour) {
    return 'rest';
  }
  if (profile.peakHours.includes(currentHour)) return 'peak';
  if (profile.lowHours.includes(currentHour)) return 'low';
  return 'normal';
}

// ============================================================================
// DEFAULT
// ============================================================================

function defaultProfile(): ChronoBioProfile {
  return {
    peakHours: [9, 10, 11],
    lowHours: [14, 15, 22],
    averageFirstActionHour: 9,
    averageLastActionHour: 18,
    weekendActive: false,
    confidence: 0,
  };
}
