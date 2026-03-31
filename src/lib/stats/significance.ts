/**
 * Statistical Significance — Pure math, no dependencies.
 *
 * Compatible with the cloud dashboard's stats/significance.ts module.
 * Provides hypothesis testing and power analysis for the self-improvement
 * cycle, replacing hardcoded thresholds with principled statistical decisions.
 *
 * Used by:
 * - Task router: require significance before shifting routing traffic
 * - Skill/principle promotion: replace hardcoded thresholds with p<0.05
 * - Improvement cycle: determine minimum sample sizes
 */

// ============================================================================
// TWO-PROPORTION Z-TEST
// ============================================================================

export interface ProportionTestResult {
  /** z-statistic */
  z: number;
  /** two-tailed p-value */
  pValue: number;
  /** true if p < alpha */
  significant: boolean;
  /** observed difference (p1 - p2) */
  difference: number;
}

/**
 * Two-proportion z-test for comparing success rates.
 *
 * @param successes1 - successes in group A
 * @param n1 - total trials in group A
 * @param successes2 - successes in group B
 * @param n2 - total trials in group B
 * @param alpha - significance level (default 0.05)
 */
export function proportionTest(
  successes1: number, n1: number,
  successes2: number, n2: number,
  alpha = 0.05,
): ProportionTestResult {
  if (n1 === 0 || n2 === 0) {
    return { z: 0, pValue: 1, significant: false, difference: 0 };
  }

  const p1 = successes1 / n1;
  const p2 = successes2 / n2;
  const pPooled = (successes1 + successes2) / (n1 + n2);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / n1 + 1 / n2));

  if (se === 0) {
    return { z: 0, pValue: 1, significant: false, difference: p1 - p2 };
  }

  const z = (p1 - p2) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));

  return {
    z,
    pValue,
    significant: pValue < alpha,
    difference: p1 - p2,
  };
}

// ============================================================================
// WELCH'S T-TEST
// ============================================================================

export interface TTestResult {
  /** t-statistic */
  t: number;
  /** degrees of freedom (Welch-Satterthwaite) */
  df: number;
  /** two-tailed p-value */
  pValue: number;
  /** true if p < alpha */
  significant: boolean;
  /** mean difference (mean1 - mean2) */
  difference: number;
}

/**
 * Welch's t-test for comparing means of two independent samples
 * with potentially unequal variances.
 *
 * @param mean1 - sample mean of group A
 * @param var1 - sample variance of group A
 * @param n1 - sample size of group A
 * @param mean2 - sample mean of group B
 * @param var2 - sample variance of group B
 * @param n2 - sample size of group B
 * @param alpha - significance level (default 0.05)
 */
export function welchTTest(
  mean1: number, var1: number, n1: number,
  mean2: number, var2: number, n2: number,
  alpha = 0.05,
): TTestResult {
  if (n1 < 2 || n2 < 2) {
    return { t: 0, df: 0, pValue: 1, significant: false, difference: mean1 - mean2 };
  }

  const se1 = var1 / n1;
  const se2 = var2 / n2;
  const se = Math.sqrt(se1 + se2);

  if (se === 0) {
    return { t: 0, df: n1 + n2 - 2, pValue: 1, significant: false, difference: mean1 - mean2 };
  }

  const t = (mean1 - mean2) / se;

  // Welch-Satterthwaite degrees of freedom
  const df = (se1 + se2) ** 2 / (se1 ** 2 / (n1 - 1) + se2 ** 2 / (n2 - 1));

  // Two-tailed p-value using Student's t approximation
  const pValue = 2 * (1 - tCdf(Math.abs(t), df));

  return {
    t,
    df,
    pValue,
    significant: pValue < alpha,
    difference: mean1 - mean2,
  };
}

// ============================================================================
// POWER ANALYSIS
// ============================================================================

/**
 * Minimum sample size per group for a two-proportion test.
 *
 * @param p1 - expected proportion in group A
 * @param p2 - expected proportion in group B (the difference to detect)
 * @param alpha - significance level (default 0.05)
 * @param power - desired power (default 0.80)
 * @returns required n per group
 */
export function minimumSampleSize(
  p1: number,
  p2: number,
  alpha = 0.05,
  power = 0.80,
): number {
  const zAlpha = normalQuantile(1 - alpha / 2);
  const zBeta = normalQuantile(power);
  const pBar = (p1 + p2) / 2;
  const delta = Math.abs(p1 - p2);

  if (delta === 0) return Infinity;

  const n = ((zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) +
    zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) / delta) ** 2;

  return Math.ceil(n);
}

// ============================================================================
// WILSON SCORE INTERVAL
// ============================================================================

export interface ConfidenceInterval {
  /** point estimate */
  center: number;
  /** lower bound */
  lower: number;
  /** upper bound */
  upper: number;
}

/**
 * Wilson score interval for a single proportion.
 * Better than the normal approximation when n is small or p is near 0 or 1.
 *
 * @param successes - number of successes
 * @param n - total trials
 * @param alpha - significance level for 1-alpha confidence (default 0.05 → 95% CI)
 */
export function wilsonInterval(
  successes: number,
  n: number,
  alpha = 0.05,
): ConfidenceInterval {
  if (n === 0) {
    return { center: 0, lower: 0, upper: 0 };
  }

  const z = normalQuantile(1 - alpha / 2);
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z / denominator) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));

  return {
    center,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

// ============================================================================
// INTERNAL: NORMAL DISTRIBUTION HELPERS
// ============================================================================

/**
 * Standard normal CDF (Φ) using Abramowitz & Stegun approximation.
 * Max error: 1.5e-7.
 */
function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);

  return 0.5 * (1 + sign * y);
}

/**
 * Normal quantile (inverse CDF) using rational approximation.
 * Accurate to ~4.5e-4 for 0.0027 < p < 0.9973.
 */
function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  // Rational approximation (Peter Acklam's algorithm)
  const a = [
    -3.969683028665376e1, 2.209460984245205e2,
    -2.759285104469687e2, 1.383577518672690e2,
    -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2,
    -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1,
    -2.400758277161838e0, -2.549732539343734e0,
    4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1,
    2.445134137142996e0, 3.754408661907416e0,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number, r: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

/**
 * Student's t CDF approximation using the incomplete beta function.
 * For the task router's typical sample sizes (10-100), this is sufficiently accurate.
 */
function tCdf(t: number, df: number): number {
  if (df <= 0) return 0.5;
  const x = df / (df + t * t);
  return 1 - 0.5 * incompleteBeta(df / 2, 0.5, x);
}

/**
 * Regularized incomplete beta function I_x(a, b)
 * using a continued fraction expansion (Lentz's method).
 */
function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Use the symmetry relation when x > (a+1)/(a+b+2) for better convergence
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - incompleteBeta(b, a, 1 - x);
  }

  const lnBeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

  // Continued fraction (Lentz's algorithm)
  let f = 1;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  f = d;

  for (let m = 1; m <= 200; m++) {
    // Even step
    let numerator = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    f *= d * c;

    // Odd step
    numerator = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const delta = d * c;
    f *= delta;

    if (Math.abs(delta - 1) < 1e-10) break;
  }

  return front * f;
}

/**
 * Log-gamma function (Lanczos approximation, g=7).
 */
function lgamma(x: number): number {
  const coef = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];

  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }

  x -= 1;
  let a = coef[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) {
    a += coef[i] / (x + i);
  }

  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
