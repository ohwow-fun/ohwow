import { describe, it, expect } from 'vitest';
import { diffScrapeSnapshots, MAX_LINES_PER_SIDE } from '../scrape-diff.js';

describe('diffScrapeSnapshots', () => {
  it('returns empty sets when snapshots are identical', () => {
    const snap = 'Pro\n$9/mo\nTeam\n$29/mo';
    const res = diffScrapeSnapshots(snap, snap);
    expect(res.added).toEqual([]);
    expect(res.removed).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  it('captures added and removed lines', () => {
    const oldSnap = 'Pro\n$9/mo\nTeam\n$29/mo';
    const newSnap = 'Pro\n$12/mo\nTeam\n$29/mo\nEnterprise';
    const res = diffScrapeSnapshots(oldSnap, newSnap);
    expect(res.added).toEqual(['$12/mo', 'Enterprise']);
    expect(res.removed).toEqual(['$9/mo']);
    expect(res.truncated).toBe(false);
  });

  it('ignores empty lines', () => {
    const oldSnap = 'Pro\n\n$9/mo';
    const newSnap = 'Pro\n\n\n$9/mo';
    const res = diffScrapeSnapshots(oldSnap, newSnap);
    expect(res.added).toEqual([]);
    expect(res.removed).toEqual([]);
  });

  it('dedups repeated lines on each side', () => {
    const oldSnap = 'A\nA\nB';
    const newSnap = 'C\nC\nD';
    const res = diffScrapeSnapshots(oldSnap, newSnap);
    expect(res.added).toEqual(['C', 'D']);
    expect(res.removed).toEqual(['A', 'B']);
  });

  it('caps output at MAX_LINES_PER_SIDE per side', () => {
    const oldLines = Array.from({ length: 100 }, (_, i) => `old-${i}`).join('\n');
    const newLines = Array.from({ length: 100 }, (_, i) => `new-${i}`).join('\n');
    const res = diffScrapeSnapshots(oldLines, newLines);
    expect(res.added.length).toBe(MAX_LINES_PER_SIDE);
    expect(res.removed.length).toBe(MAX_LINES_PER_SIDE);
    expect(res.truncated).toBe(true);
  });

  it('respects custom cap', () => {
    const oldSnap = 'a\nb\nc\nd\ne';
    const newSnap = 'f\ng\nh\ni\nj';
    const res = diffScrapeSnapshots(oldSnap, newSnap, 3);
    expect(res.added.length).toBe(3);
    expect(res.removed.length).toBe(3);
    expect(res.truncated).toBe(true);
  });

  it('handles empty old snapshot (first-run case)', () => {
    const res = diffScrapeSnapshots('', 'Pro\n$9/mo');
    expect(res.added).toEqual(['Pro', '$9/mo']);
    expect(res.removed).toEqual([]);
  });

  it('preserves input order on each side', () => {
    const oldSnap = 'x\ny\nz';
    const newSnap = 'alpha\nbeta\ngamma';
    const res = diffScrapeSnapshots(oldSnap, newSnap);
    expect(res.added).toEqual(['alpha', 'beta', 'gamma']);
    expect(res.removed).toEqual(['x', 'y', 'z']);
  });
});
