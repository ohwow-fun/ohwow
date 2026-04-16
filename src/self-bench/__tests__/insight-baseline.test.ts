import { describe, it, expect } from 'vitest';
import {
  computeNovelty,
  welfordUpdate,
  type ObservationBaselineRow,
} from '../insight-baseline.js';
import type { NewFindingRow } from '../experiment-types.js';

function makeRow(overrides: Partial<NewFindingRow> = {}): NewFindingRow {
  return {
    experimentId: 'x-ops-observer',
    category: 'other',
    subject: 'x-ops:summary',
    hypothesis: 'h',
    verdict: 'warning',
    summary: 's',
    evidence: {},
    interventionApplied: null,
    ranAt: '2026-04-16T06:00:00.000Z',
    durationMs: 1,
    ...overrides,
  };
}

function makeBaseline(overrides: Partial<ObservationBaselineRow> = {}): ObservationBaselineRow {
  return {
    experiment_id: 'x-ops-observer',
    subject: 'x-ops:summary',
    first_seen_at: '2026-04-15T00:00:00.000Z',
    last_seen_at: '2026-04-16T05:59:00.000Z',
    sample_count: 10,
    tracked_field: null,
    running_mean: null,
    running_m2: null,
    last_value: null,
    last_verdict: 'pass',
    consecutive_fails: 0,
    updated_at: '2026-04-16T05:59:00.000Z',
    ...overrides,
  };
}

describe('computeNovelty', () => {
  it('scores first_seen when there is no baseline', () => {
    const out = computeNovelty(null, makeRow({ verdict: 'fail' }));
    expect(out.reason).toBe('first_seen');
    expect(out.score).toBe(1);
    expect(out.consecutive_fails).toBe(1);
  });

  it('flags verdict flip pass→fail as high novelty', () => {
    const out = computeNovelty(
      makeBaseline({ last_verdict: 'pass' }),
      makeRow({ verdict: 'fail' }),
    );
    expect(out.reason).toBe('verdict_flipped');
    expect(out.score).toBeGreaterThanOrEqual(0.9);
    expect(out.detail).toBe('pass→fail');
  });

  it('flags verdict flip fail→pass as high novelty (recovery)', () => {
    const out = computeNovelty(
      makeBaseline({ last_verdict: 'fail', consecutive_fails: 12 }),
      makeRow({ verdict: 'pass' }),
    );
    expect(out.reason).toBe('verdict_flipped');
    expect(out.detail).toBe('fail→pass');
    expect(out.consecutive_fails).toBe(0);
  });

  it('scores z>=3 as extreme when a tracked value diverges from baseline', () => {
    const out = computeNovelty(
      makeBaseline({
        tracked_field: 'rate',
        running_mean: 0.8,
        running_m2: 0.04 * 9, // variance ~0.04, stddev ~0.2
        sample_count: 10,
      }),
      makeRow({
        verdict: 'warning',
        evidence: { __tracked_field: 'rate', rate: 0.1 },
      }),
    );
    expect(out.reason).toBe('value_z');
    expect(out.score).toBeGreaterThanOrEqual(0.9);
    expect(out.z_score).toBeGreaterThanOrEqual(3);
  });

  it('returns normal when tracked value is within 1σ and verdict held', () => {
    const out = computeNovelty(
      makeBaseline({
        tracked_field: 'rate',
        running_mean: 0.8,
        running_m2: 0.04 * 9,
        sample_count: 10,
        last_verdict: 'pass',
      }),
      makeRow({
        verdict: 'pass',
        evidence: { __tracked_field: 'rate', rate: 0.82 },
      }),
    );
    expect(out.reason).toBe('normal');
    expect(out.score).toBe(0);
  });

  it('emits repeat_count at the 10-fail milestone but stays quiet on 11', () => {
    const hit10 = computeNovelty(
      makeBaseline({ last_verdict: 'fail', consecutive_fails: 9 }),
      makeRow({ verdict: 'fail' }),
    );
    expect(hit10.reason).toBe('repeat_count');
    expect(hit10.detail).toBe('consecutive_fails=10');

    const silent11 = computeNovelty(
      makeBaseline({ last_verdict: 'fail', consecutive_fails: 10 }),
      makeRow({ verdict: 'fail' }),
    );
    expect(silent11.reason).toBe('normal');
    expect(silent11.score).toBe(0);
    expect(silent11.consecutive_fails).toBe(11);
  });

  it('does not z-score below MIN_SAMPLES_FOR_Z', () => {
    const out = computeNovelty(
      makeBaseline({
        tracked_field: 'rate',
        running_mean: 0.8,
        running_m2: 0.04 * 2,
        sample_count: 3, // below threshold
        last_verdict: 'warning',
      }),
      makeRow({
        verdict: 'warning',
        evidence: { __tracked_field: 'rate', rate: 0.0 },
      }),
    );
    expect(out.reason).not.toBe('value_z');
  });
});

describe('welfordUpdate', () => {
  it('initializes running stats on the first numeric sample', () => {
    const out = welfordUpdate(null, 10, 'rate');
    expect(out.sample_count).toBe(1);
    expect(out.running_mean).toBe(10);
    expect(out.running_m2).toBe(0);
  });

  it('converges to the true mean over many samples', () => {
    let base: ObservationBaselineRow | null = null;
    const now = '2026-04-16T06:00:00.000Z';
    const xs = [10, 12, 11, 9, 10, 11, 13, 8, 10, 10];
    for (const x of xs) {
      const u = welfordUpdate(base, x, 'rate');
      base = {
        experiment_id: 'e',
        subject: 's',
        first_seen_at: now,
        last_seen_at: now,
        sample_count: u.sample_count,
        tracked_field: u.tracked_field,
        running_mean: u.running_mean,
        running_m2: u.running_m2,
        last_value: u.last_value,
        last_verdict: 'pass',
        consecutive_fails: 0,
        updated_at: now,
      };
    }
    expect(base!.sample_count).toBe(10);
    const mean = base!.running_mean!;
    expect(mean).toBeCloseTo(10.4, 5);
  });

  it('restarts stats when the caller switches tracked_field mid-stream', () => {
    const before: ObservationBaselineRow = {
      experiment_id: 'e',
      subject: 's',
      first_seen_at: '2026-04-16T00:00:00.000Z',
      last_seen_at: '2026-04-16T00:00:00.000Z',
      sample_count: 10,
      tracked_field: 'rate_a',
      running_mean: 5,
      running_m2: 4,
      last_value: 5,
      last_verdict: 'pass',
      consecutive_fails: 0,
      updated_at: '2026-04-16T00:00:00.000Z',
    };
    const out = welfordUpdate(before, 99, 'rate_b');
    expect(out.tracked_field).toBe('rate_b');
    expect(out.sample_count).toBe(1);
    expect(out.running_mean).toBe(99);
    expect(out.running_m2).toBe(0);
  });

  it('bumps sample_count without touching stats when no tracked_field is provided', () => {
    const before: ObservationBaselineRow = {
      experiment_id: 'e',
      subject: 's',
      first_seen_at: '2026-04-16T00:00:00.000Z',
      last_seen_at: '2026-04-16T00:00:00.000Z',
      sample_count: 7,
      tracked_field: null,
      running_mean: null,
      running_m2: null,
      last_value: null,
      last_verdict: 'pass',
      consecutive_fails: 0,
      updated_at: '2026-04-16T00:00:00.000Z',
    };
    const out = welfordUpdate(before, null, null);
    expect(out.sample_count).toBe(8);
    expect(out.running_mean).toBeNull();
    expect(out.tracked_field).toBeNull();
  });
});
