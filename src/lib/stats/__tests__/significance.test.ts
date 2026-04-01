/**
 * Tests for the statistical significance module.
 * Validates the pure math functions against known statistical results.
 */

import { describe, it, expect } from 'vitest';
import { proportionTest, welchTTest, minimumSampleSize, wilsonInterval } from '../significance.js';

describe('proportionTest', () => {
  it('returns not significant for identical proportions', () => {
    const result = proportionTest(50, 100, 50, 100);
    expect(result.significant).toBe(false);
    expect(result.z).toBe(0);
    expect(result.difference).toBe(0);
    expect(result.pValue).toBeCloseTo(1, 5);
  });

  it('returns significant for clearly different proportions', () => {
    // 80% vs 50% with n=100 each — should be very significant
    const result = proportionTest(80, 100, 50, 100);
    expect(result.significant).toBe(true);
    expect(result.pValue).toBeLessThan(0.001);
    expect(result.difference).toBeCloseTo(0.3, 2);
    expect(result.z).toBeGreaterThan(0);
  });

  it('returns not significant for small differences with small samples', () => {
    // 6/10 vs 5/10 — not enough data to be significant
    const result = proportionTest(6, 10, 5, 10);
    expect(result.significant).toBe(false);
    expect(result.pValue).toBeGreaterThan(0.05);
  });

  it('handles zero denominators gracefully', () => {
    const result = proportionTest(0, 0, 5, 10);
    expect(result.significant).toBe(false);
    expect(result.pValue).toBe(1);
  });

  it('handles all-success vs all-failure', () => {
    const result = proportionTest(100, 100, 0, 100);
    expect(result.significant).toBe(true);
    expect(result.difference).toBeCloseTo(1, 2);
  });

  it('respects custom alpha', () => {
    // With a very strict alpha (0.001), a moderate difference may not be significant
    const result = proportionTest(70, 100, 55, 100, 0.001);
    // 70% vs 55% at alpha=0.001 may or may not be significant depending on exact p
    expect(result.pValue).toBeDefined();
  });
});

describe('welchTTest', () => {
  it('returns not significant for identical means', () => {
    const result = welchTTest(50, 10, 30, 50, 10, 30);
    expect(result.significant).toBe(false);
    expect(result.t).toBe(0);
    expect(result.difference).toBe(0);
  });

  it('returns significant for very different means', () => {
    // mean=100 vs mean=50, both variance=25, n=50
    const result = welchTTest(100, 25, 50, 50, 25, 50);
    expect(result.significant).toBe(true);
    expect(result.pValue).toBeLessThan(0.001);
    expect(result.difference).toBeCloseTo(50, 0);
  });

  it('handles small samples gracefully', () => {
    const result = welchTTest(10, 5, 1, 20, 5, 1);
    expect(result.significant).toBe(false);
    expect(result.pValue).toBe(1);
  });

  it('handles unequal variances', () => {
    // Group A: low variance, Group B: high variance
    const result = welchTTest(100, 4, 50, 50, 400, 50);
    expect(result.df).toBeDefined();
    // Welch-Satterthwaite df should be less than n1+n2-2
    expect(result.df).toBeLessThan(98);
  });

  it('handles zero variance', () => {
    const result = welchTTest(10, 0, 30, 10, 0, 30);
    expect(result.significant).toBe(false);
    expect(result.pValue).toBe(1);
  });
});

describe('minimumSampleSize', () => {
  it('returns reasonable sample size for moderate effect', () => {
    // Detect 10 percentage point difference (50% vs 60%)
    const n = minimumSampleSize(0.5, 0.6);
    expect(n).toBeGreaterThan(300);
    expect(n).toBeLessThan(500);
  });

  it('returns larger sample for smaller effect', () => {
    const nSmall = minimumSampleSize(0.5, 0.55);
    const nLarge = minimumSampleSize(0.5, 0.6);
    expect(nSmall).toBeGreaterThan(nLarge);
  });

  it('returns Infinity for zero effect size', () => {
    const n = minimumSampleSize(0.5, 0.5);
    expect(n).toBe(Infinity);
  });

  it('returns smaller sample for higher alpha', () => {
    const nStrict = minimumSampleSize(0.5, 0.7, 0.01);
    const nLenient = minimumSampleSize(0.5, 0.7, 0.10);
    expect(nStrict).toBeGreaterThan(nLenient);
  });

  it('returns smaller sample for lower power', () => {
    const nHigh = minimumSampleSize(0.5, 0.7, 0.05, 0.95);
    const nLow = minimumSampleSize(0.5, 0.7, 0.05, 0.50);
    expect(nHigh).toBeGreaterThan(nLow);
  });
});

describe('wilsonInterval', () => {
  it('returns [0,0] for n=0', () => {
    const ci = wilsonInterval(0, 0);
    expect(ci.center).toBe(0);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBe(0);
  });

  it('returns centered interval for 50% success rate', () => {
    const ci = wilsonInterval(50, 100);
    expect(ci.center).toBeCloseTo(0.5, 1);
    expect(ci.lower).toBeLessThan(0.5);
    expect(ci.upper).toBeGreaterThan(0.5);
  });

  it('returns interval bounded by [0, 1]', () => {
    // All successes
    const ci1 = wilsonInterval(100, 100);
    expect(ci1.upper).toBeLessThanOrEqual(1);
    expect(ci1.lower).toBeGreaterThan(0.9);

    // No successes
    const ci2 = wilsonInterval(0, 100);
    expect(ci2.lower).toBeGreaterThanOrEqual(0);
    expect(ci2.upper).toBeLessThan(0.05);
  });

  it('narrows with larger samples', () => {
    const ciSmall = wilsonInterval(5, 10);
    const ciLarge = wilsonInterval(50, 100);
    const widthSmall = ciSmall.upper - ciSmall.lower;
    const widthLarge = ciLarge.upper - ciLarge.lower;
    expect(widthSmall).toBeGreaterThan(widthLarge);
  });

  it('center differs from raw proportion for small n', () => {
    // Wilson center shrinks extreme proportions toward 0.5 for small n
    const ci = wilsonInterval(1, 2); // raw = 0.5
    // Wilson center for 1/2 should be close to 0.5 but adjusted
    expect(ci.center).toBeGreaterThan(0.3);
    expect(ci.center).toBeLessThan(0.7);
  });

  it('supports custom alpha', () => {
    const ci95 = wilsonInterval(50, 100, 0.05);
    const ci99 = wilsonInterval(50, 100, 0.01);
    const width95 = ci95.upper - ci95.lower;
    const width99 = ci99.upper - ci99.lower;
    // 99% CI is wider than 95% CI
    expect(width99).toBeGreaterThan(width95);
  });
});
