import { describe, it, expect, vi } from 'vitest';
import { makeScoreSurprise } from '../surprise.js';

function stubDb(row: Record<string, unknown> | null) {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.limit = () => Promise.resolve({ data: row ? [row] : [], error: null });
  return { from: vi.fn().mockImplementation(() => builder) };
}

describe('makeScoreSurprise', () => {
  it('returns first_seen when no baseline row exists', async () => {
    const score = makeScoreSurprise(stubDb(null) as never, 'my-exp');
    const out = await score({ subject: 's1', verdict: 'fail' });
    expect(out.reason).toBe('first_seen');
    expect(out.score).toBe(1);
    expect(out.consecutiveFails).toBe(1);
    expect(out.baseline).toBeNull();
  });

  it('flags verdict_flipped when baseline verdict differs', async () => {
    const baseline = {
      experiment_id: 'my-exp',
      subject: 's1',
      first_seen_at: '2026-04-15T00:00:00Z',
      last_seen_at: '2026-04-15T23:00:00Z',
      sample_count: 20,
      tracked_field: null,
      running_mean: null,
      running_m2: null,
      last_value: null,
      last_verdict: 'pass',
      consecutive_fails: 0,
      updated_at: '2026-04-15T23:00:00Z',
    };
    const score = makeScoreSurprise(stubDb(baseline) as never, 'my-exp');
    const out = await score({ subject: 's1', verdict: 'fail' });
    expect(out.reason).toBe('verdict_flipped');
    expect(out.score).toBeGreaterThanOrEqual(0.9);
  });

  it('returns baseline mean + stddev when there is sufficient sample data', async () => {
    const baseline = {
      experiment_id: 'my-exp',
      subject: 's1',
      first_seen_at: '2026-04-15T00:00:00Z',
      last_seen_at: '2026-04-15T23:00:00Z',
      sample_count: 10,
      tracked_field: 'rate',
      running_mean: 0.8,
      running_m2: 0.04 * 9, // variance 0.04, stddev 0.2
      last_value: 0.78,
      last_verdict: 'pass',
      consecutive_fails: 0,
      updated_at: '2026-04-15T23:00:00Z',
    };
    const score = makeScoreSurprise(stubDb(baseline) as never, 'my-exp');
    const out = await score({
      subject: 's1',
      verdict: 'warning',
      trackedField: 'rate',
      value: 0.1,
    });
    expect(out.baseline?.mean).toBe(0.8);
    expect(out.baseline?.stddev).toBeCloseTo(0.2, 2);
    expect(out.reason).toBe('value_z');
    expect(out.zScore).toBeGreaterThanOrEqual(3);
  });

  it('score=0 / reason=normal for in-baseline observations', async () => {
    const baseline = {
      experiment_id: 'my-exp',
      subject: 's1',
      first_seen_at: '2026-04-15T00:00:00Z',
      last_seen_at: '2026-04-15T23:00:00Z',
      sample_count: 20,
      tracked_field: 'rate',
      running_mean: 0.8,
      running_m2: 0.04 * 19,
      last_value: 0.79,
      last_verdict: 'pass',
      consecutive_fails: 0,
      updated_at: '2026-04-15T23:00:00Z',
    };
    const score = makeScoreSurprise(stubDb(baseline) as never, 'my-exp');
    const out = await score({
      subject: 's1',
      verdict: 'pass',
      trackedField: 'rate',
      value: 0.82,
    });
    expect(out.reason).toBe('normal');
    expect(out.score).toBe(0);
  });
});
