/**
 * Respect for the boundary between work and life
 */

import type { WorkLifeBoundary } from './types.js';

const STRICT_THRESHOLD = 0.8;

/**
 * Infer work-life boundaries from historical activity timestamps.
 *
 * Analyzes the hour-of-day distribution to find the core working window.
 * If >80% of activity falls within a contiguous window, the boundary is strict.
 * Otherwise, flexible. Days with zero activity are marked as quiet days.
 */
export function inferBoundary(actionTimestamps: number[]): WorkLifeBoundary {
  if (actionTimestamps.length === 0) {
    return {
      workStartHour: 9,
      workEndHour: 17,
      quietDays: [0, 6], // Sunday, Saturday
      respectLevel: 'flexible',
    };
  }

  // Count activity per hour and per day-of-week
  const hourCounts = new Array(24).fill(0) as number[];
  const dayCounts = new Array(7).fill(0) as number[];

  for (const ts of actionTimestamps) {
    const d = new Date(ts);
    hourCounts[d.getHours()]++;
    dayCounts[d.getDay()]++;
  }

  // Find the contiguous window with the most activity
  let bestStart = 9;
  let bestEnd = 17;
  let bestCount = 0;

  for (let start = 0; start < 24; start++) {
    for (let duration = 4; duration <= 16; duration++) {
      let count = 0;
      for (let h = 0; h < duration; h++) {
        count += hourCounts[(start + h) % 24];
      }
      if (count > bestCount) {
        bestCount = count;
        bestStart = start;
        bestEnd = (start + duration) % 24;
      }
    }
  }

  const total = actionTimestamps.length;
  const ratio = total > 0 ? bestCount / total : 0;
  const respectLevel: WorkLifeBoundary['respectLevel'] =
    ratio >= STRICT_THRESHOLD ? 'strict' : 'flexible';

  // Quiet days: days with <5% of total activity
  const quietDays: number[] = [];
  for (let day = 0; day < 7; day++) {
    if (dayCounts[day] / total < 0.05) {
      quietDays.push(day);
    }
  }

  return {
    workStartHour: bestStart,
    workEndHour: bestEnd,
    quietDays,
    respectLevel,
  };
}

/**
 * Check if the current moment falls outside the work boundary.
 */
export function isBoundaryActive(
  boundary: WorkLifeBoundary,
  now?: Date
): boolean {
  if (boundary.respectLevel === 'none') {
    return false;
  }

  const current = now ?? new Date();
  const hour = current.getHours();
  const day = current.getDay();

  // Quiet day check
  if (boundary.quietDays.includes(day)) {
    return true;
  }

  // Outside work hours check
  if (boundary.workStartHour < boundary.workEndHour) {
    // Normal range (e.g., 9-17)
    return hour < boundary.workStartHour || hour >= boundary.workEndHour;
  } else {
    // Wrapping range (e.g., 22-6 for night owls)
    return hour < boundary.workStartHour && hour >= boundary.workEndHour;
  }
}
