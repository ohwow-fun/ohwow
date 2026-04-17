import { describe, it, expect } from 'vitest';
import { normalizeSqliteTimestamp, parseSqliteTimestamp } from '../sqlite-time.js';

describe('normalizeSqliteTimestamp', () => {
  it('adds Z suffix to SQLite-style "YYYY-MM-DD HH:MM:SS"', () => {
    expect(normalizeSqliteTimestamp('2026-04-17 14:18:02')).toBe('2026-04-17T14:18:02Z');
  });

  it('preserves strings that already have a Z suffix', () => {
    expect(normalizeSqliteTimestamp('2026-04-17T14:18:02Z')).toBe('2026-04-17T14:18:02Z');
  });

  it('preserves strings with an explicit +HH:MM offset', () => {
    expect(normalizeSqliteTimestamp('2026-04-17T14:18:02+00:00')).toBe('2026-04-17T14:18:02+00:00');
  });

  it('preserves strings with an explicit -HH:MM offset', () => {
    expect(normalizeSqliteTimestamp('2026-04-17T09:18:02-05:00')).toBe('2026-04-17T09:18:02-05:00');
  });

  it('trims whitespace', () => {
    expect(normalizeSqliteTimestamp('  2026-04-17 14:18:02  ')).toBe('2026-04-17T14:18:02Z');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeSqliteTimestamp('')).toBe('');
  });
});

describe('parseSqliteTimestamp', () => {
  it('parses a SQLite no-TZ string as UTC', () => {
    // The bug-demonstrating case: raw Date.parse would interpret this
    // as local time, producing a different ms value in any non-UTC
    // timezone. parseSqliteTimestamp must always produce the UTC value.
    const expected = Date.UTC(2026, 3, 17, 14, 18, 2); // Apr 17, 2026 14:18:02 UTC
    expect(parseSqliteTimestamp('2026-04-17 14:18:02')).toBe(expected);
  });

  it('is idempotent for strings already in ISO-8601 with Z', () => {
    const expected = Date.UTC(2026, 3, 17, 14, 18, 2);
    expect(parseSqliteTimestamp('2026-04-17T14:18:02Z')).toBe(expected);
  });

  it('returns NaN for null/undefined input', () => {
    expect(parseSqliteTimestamp(null)).toBeNaN();
    expect(parseSqliteTimestamp(undefined)).toBeNaN();
  });

  it('returns NaN for unparseable input', () => {
    expect(parseSqliteTimestamp('not-a-date')).toBeNaN();
  });

  it('fixes the "negative seconds since" cooldown bug', () => {
    // The actual bug from 2026-04-17: sinceLastSec = -15269 because
    // a UTC SQLite string was parsed as local time. Simulate: pick a
    // timestamp in the past (UTC), verify Date.now() - parsed > 0.
    const pastUtc = '2026-04-17 14:18:02';
    const parsed = parseSqliteTimestamp(pastUtc);
    // At any time AFTER 14:18:02 UTC on that date, delta should be >= 0.
    // The original bug made this negative. We can't check against a
    // specific Date.now, but we CAN check parsed is a reasonable ms value.
    expect(parsed).toBe(Date.UTC(2026, 3, 17, 14, 18, 2));
    expect(Number.isFinite(parsed)).toBe(true);
  });
});
