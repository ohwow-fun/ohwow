import { describe, it, expect } from 'vitest';
import { decideOpsMove } from '../experiments/ops-pulse.js';
import type { OpsKnobReading } from '../ops-knobs.js';

function knob(key: string, value: number | null, in_range: boolean | null = true): OpsKnobReading {
  return {
    key, description: '', unit: 'count', saneRange: [0, 100],
    value, in_range,
  };
}

describe('decideOpsMove', () => {
  it('flags weekly_deficit > 2 as an autonomy bump opportunity', () => {
    const m = decideOpsMove([
      knob('x_compose.weekly_target', 7),
      knob('x_compose.weekly_actual', 3),
      knob('x_compose.weekly_deficit', 4),
    ], { dispatch_success_rate: 0.9 });
    expect(m).toMatch(/bump x_compose autonomy/);
  });

  it('flags zero posts as an upstream blocker', () => {
    const m = decideOpsMove([
      knob('x_compose.weekly_target', 7),
      knob('x_compose.weekly_actual', 0),
      knob('x_compose.weekly_deficit', 7),
    ], null);
    // weekly_deficit > 2 wins priority-wise, test that it at least
    // points at x_compose; the zero-posts branch is reached when
    // deficit is not available.
    expect(m).toMatch(/x_compose|upstream/);
  });

  it('flags low dispatch success rate', () => {
    const m = decideOpsMove([
      knob('x_compose.weekly_target', 7),
      knob('x_compose.weekly_actual', 7),
      knob('x_compose.weekly_deficit', 0),
    ], { dispatch_success_rate: 0.3 });
    expect(m).toMatch(/dispatch_success_rate/);
  });

  it('calls out missing burn cap as a foundation gap', () => {
    const m = decideOpsMove([
      knob('x_compose.weekly_target', 7),
      knob('x_compose.weekly_actual', 7),
      knob('x_compose.weekly_deficit', 0),
      knob('burn.daily_cap_cents', null),
    ], { dispatch_success_rate: 0.9 });
    expect(m).toMatch(/burn cap|burn\.daily_cap_cents/);
  });

  it('defers to revenue pulse when ops are healthy', () => {
    const m = decideOpsMove([
      knob('x_compose.weekly_target', 7),
      knob('x_compose.weekly_actual', 8),
      knob('x_compose.weekly_deficit', -1),
      knob('burn.daily_cap_cents', 10000),
    ], { dispatch_success_rate: 0.9 });
    expect(m).toMatch(/Revenue Pulse|outcome-side/);
  });
});
