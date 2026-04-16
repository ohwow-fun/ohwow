import { describe, it, expect } from 'vitest';
import { cloudIsNewer } from '../client.js';

describe('cloudIsNewer', () => {
  it('returns true when cloud timestamp is strictly after local — same ISO format', () => {
    expect(cloudIsNewer('2026-04-16T12:00:00.000Z', '2026-04-16T08:00:00.000Z')).toBe(true);
    expect(cloudIsNewer('2026-04-17T00:00:00.000Z', '2026-04-16T23:59:59.000Z')).toBe(true);
  });

  it('returns false when local is newer, same ISO format', () => {
    expect(cloudIsNewer('2026-04-16T08:00:00.000Z', '2026-04-16T12:00:00.000Z')).toBe(false);
  });

  it('returns false at exact equality', () => {
    expect(cloudIsNewer('2026-04-16T12:00:00.000Z', '2026-04-16T12:00:00.000Z')).toBe(false);
  });

  // The regression this patch fixes: before, cloud's T-separator format
  // lexicographically beat SQLite's space-separator format regardless of
  // actual time, so local edits made via raw SQL `datetime('now')` were
  // always undone at boot.
  it('compares across cloud ISO-T-Z and SQLite space-separator formats by wall clock', () => {
    // Cloud says 05:57 UTC; local says 12:53 — local is LATER.
    // String `>` would incorrectly return true (cloud wins) because
    // 'T' > ' '. The patched helper must return false.
    expect(cloudIsNewer('2026-04-16T05:57:23.000Z', '2026-04-16 12:53:14')).toBe(false);
  });

  it('returns true when cloud is genuinely newer across mixed formats', () => {
    expect(cloudIsNewer('2026-04-16T15:00:00.000Z', '2026-04-16 08:00:00')).toBe(true);
  });

  it('falls back to lexicographic compare when a side fails to parse', () => {
    // 'garbage' does not parse — helper falls back to string >.
    // 'zzz' > 'garbage' lexicographically.
    expect(cloudIsNewer('zzz', 'garbage')).toBe(true);
    expect(cloudIsNewer('garbage', 'zzz')).toBe(false);
  });
});
