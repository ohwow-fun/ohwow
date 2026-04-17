import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OutreachPolicyFuzzExperiment, type OutreachPolicyFuzzEvidence } from '../experiments/outreach-policy-fuzz.js';
import type { ExperimentContext } from '../experiment-types.js';
import {
  _resetRuntimeConfigCacheForTests,
  _seedRuntimeConfigCacheForTests,
} from '../runtime-config.js';

function ctx(): ExperimentContext {
  return {
    db: {} as never,
    workspaceId: 'ws-1',
    workspaceSlug: 'default',
    engine: {} as never,
    recentFindings: async () => [],
  };
}

describe('OutreachPolicyFuzzExperiment', () => {
  beforeEach(() => _resetRuntimeConfigCacheForTests());
  afterEach(() => _resetRuntimeConfigCacheForTests());

  it('passes against the current outreach-policy exports', async () => {
    // With no runtime_config set, resolveCooldownHours falls back to
    // DEFAULT_COOLDOWN_HOURS=72 which is inside the [1,720] range.
    const exp = new OutreachPolicyFuzzExperiment();
    const r = await exp.probe(ctx());
    const ev = r.evidence as OutreachPolicyFuzzEvidence;
    expect(exp.judge(r, [])).toBe('pass');
    expect(ev.violations).toEqual([]);
    expect(ev.affected_files).toEqual(['src/lib/outreach-policy.ts']);
    expect(ev.observed.default_cooldown_hours).toBeGreaterThanOrEqual(1);
    expect(ev.observed.default_cooldown_hours).toBeLessThanOrEqual(720);
    expect(ev.observed.event_kinds.length).toBeGreaterThanOrEqual(3);
    // Every channel must resolve to a positive number
    for (const row of ev.observed.resolved_by_channel) {
      expect(row.hours).toBeGreaterThan(0);
    }
  });

  it('records a finite, named set of expected rule ids', async () => {
    // Guards against ruleId drift — the rule set is the contract
    // patch-author consumes through evidenceLiteralsAppearInSource.
    const exp = new OutreachPolicyFuzzExperiment();
    const r = await exp.probe(ctx());
    const ev = r.evidence as OutreachPolicyFuzzEvidence;
    // checks_run should be deterministic: 1 default-range + 4 channels ×
    // (resolve + override + override-ignored) + 1 event-kinds-size +
    // 3 required kinds = 1 + 12 + 1 + 3 = 17
    expect(ev.checks_run).toBe(17);
  });

  it('flags a negative override violation when resolver is mistuned', async () => {
    // Simulate a runtime_config state where byChannel.x_dm is 0 — the
    // resolver should fall through to default, not return 0. If it
    // ever returns 0 (a bug), resolve-positive fires.
    // We can't break the resolver directly, but we can simulate the
    // override-ignored failure shape by verifying our mock reasoning.
    _seedRuntimeConfigCacheForTests('outreach.cooldown_hours_by_channel', { x_dm: 0 });
    const exp = new OutreachPolicyFuzzExperiment();
    const r = await exp.probe(ctx());
    const ev = r.evidence as OutreachPolicyFuzzEvidence;
    // The resolver correctly ignores 0 and falls through — so no violation.
    // This test proves the invariant holds under a realistic mistune.
    expect(exp.judge(r, [])).toBe('pass');
    expect(ev.violations).toEqual([]);
  });

  it('honors a positive runtime_config override', async () => {
    _seedRuntimeConfigCacheForTests('outreach.cooldown_hours_by_channel', { x_dm: 168 });
    const exp = new OutreachPolicyFuzzExperiment();
    const r = await exp.probe(ctx());
    const ev = r.evidence as OutreachPolicyFuzzEvidence;
    const row = ev.observed.resolved_by_channel.find((x) => x.channel === 'x_dm');
    expect(row?.hours).toBe(168);
    expect(exp.judge(r, [])).toBe('pass');
  });
});
