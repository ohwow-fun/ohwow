import { describe, it, expect } from 'vitest';
import { formatDuration } from '../format-duration.js';

/**
 * Contract:
 *   formatDuration(ms: number): string
 *
 * Render a non-negative millisecond count as a human-readable string using
 * the largest non-zero units first, separated by single spaces. Units:
 *   d (day = 86_400_000ms), h (hour = 3_600_000ms), m (min = 60_000ms),
 *   s (sec = 1_000ms), ms (millisecond).
 *
 * Rules:
 *   - Zero returns "0ms".
 *   - Only include non-zero units.
 *   - No leading zero units ("1m 0s 500ms" becomes "1m 500ms").
 *   - Sub-second durations under 1000ms render as "{n}ms".
 *   - Negative input throws RangeError("formatDuration: negative duration").
 *   - Non-integer input is floored (e.g. 1500.9 → "1s 500ms").
 */

describe('formatDuration', () => {
  it('returns "0ms" for zero', () => {
    expect(formatDuration(0)).toBe('0ms');
  });

  it('renders sub-second values as plain ms', () => {
    expect(formatDuration(1)).toBe('1ms');
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('renders exact seconds without a ms component', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(42_000)).toBe('42s');
  });

  it('renders seconds + milliseconds when both non-zero', () => {
    expect(formatDuration(1500)).toBe('1s 500ms');
    expect(formatDuration(7_250)).toBe('7s 250ms');
  });

  it('renders exact minutes without lower components', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(180_000)).toBe('3m');
  });

  it('renders minutes + seconds + milliseconds', () => {
    expect(formatDuration(61_500)).toBe('1m 1s 500ms');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });

  it('skips zero middle units rather than printing "0"', () => {
    // 1m 0s 500ms → "1m 500ms" (no 0s component)
    expect(formatDuration(60_500)).toBe('1m 500ms');
  });

  it('renders exact hours and hour + lower components', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_661_000)).toBe('1h 1m 1s');
    expect(formatDuration(7_323_456)).toBe('2h 2m 3s 456ms');
  });

  it('renders days and day + lower components', () => {
    expect(formatDuration(86_400_000)).toBe('1d');
    expect(formatDuration(90_061_000)).toBe('1d 1h 1m 1s');
    expect(formatDuration(172_800_000)).toBe('2d');
  });

  it('floors non-integer input', () => {
    expect(formatDuration(1500.9)).toBe('1s 500ms');
    expect(formatDuration(999.7)).toBe('999ms');
  });

  it('throws RangeError for negative input', () => {
    expect(() => formatDuration(-1)).toThrow(RangeError);
    expect(() => formatDuration(-1)).toThrow('formatDuration: negative duration');
  });
});
