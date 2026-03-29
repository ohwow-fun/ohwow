/**
 * Ultradian rhythms: the body's 90-minute cycles of high and low energy
 */

import type { EnergyWaveInput, EnergyWaveState } from './types.js';

const DEFAULT_WINDOW_MINUTES = 90;

/**
 * Detect the current phase of the ultradian energy cycle by analyzing
 * activity density across 90-minute windows.
 *
 * Buckets timestamps into windows, computes activity density for the
 * current window and the two preceding ones, then classifies:
 *   - Peak: current is the highest of the three
 *   - Trough: current is the lowest of the three
 *   - Rising: current > previous
 *   - Falling: current < previous
 */
export function detectEnergyWave(input: EnergyWaveInput): EnergyWaveState {
  const windowMs = (input.windowMinutes ?? DEFAULT_WINDOW_MINUTES) * 60 * 1000;
  const now = Date.now();

  if (input.activityTimestamps.length === 0) {
    return 'trough';
  }

  // Count activity in each of the last 3 windows (current, previous, two-back)
  const windowCounts = [0, 0, 0]; // [current, prev, twoPrev]

  for (const ts of input.activityTimestamps) {
    const age = now - ts;
    if (age < 0) continue;

    if (age < windowMs) {
      windowCounts[0]++;
    } else if (age < windowMs * 2) {
      windowCounts[1]++;
    } else if (age < windowMs * 3) {
      windowCounts[2]++;
    }
  }

  const [current, prev, twoPrev] = windowCounts;

  // Peak: highest of all three windows
  if (current >= prev && current >= twoPrev && current > 0) {
    return 'peak';
  }

  // Trough: lowest of all three (or no activity in current)
  if (current <= prev && current <= twoPrev) {
    return 'trough';
  }

  // Rising: current exceeds previous
  if (current > prev) {
    return 'rising';
  }

  // Falling: current below previous
  return 'falling';
}
