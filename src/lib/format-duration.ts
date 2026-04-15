const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Render a non-negative millisecond count as a human-readable string.
 *
 * Units: d (day), h (hour), m (minute), s (second), ms (millisecond).
 * Only non-zero units are included; zero-valued intermediate units are skipped.
 * Non-integer input is floored. Negative input throws RangeError.
 */
export function formatDuration(ms: number): string {
  if (ms < 0) {
    throw new RangeError('formatDuration: negative duration');
  }

  let remaining = Math.floor(ms);

  if (remaining === 0) {
    return '0ms';
  }

  const parts: string[] = [];

  const days = Math.floor(remaining / MS_PER_DAY);
  remaining %= MS_PER_DAY;

  const hours = Math.floor(remaining / MS_PER_HOUR);
  remaining %= MS_PER_HOUR;

  const minutes = Math.floor(remaining / MS_PER_MINUTE);
  remaining %= MS_PER_MINUTE;

  const seconds = Math.floor(remaining / MS_PER_SECOND);
  remaining %= MS_PER_SECOND;

  const millis = remaining;

  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  if (millis > 0) parts.push(`${millis}ms`);

  return parts.join(' ');
}