import { describe, it, expect } from 'vitest';
import {
  rankCandidates,
  topRankedCandidate,
  deriveAdaptiveWeights,
  BASELINE_WEIGHTS,
  LIFT_HEALTH_MIN_SAMPLES,
  ADAPTIVE_SCALE_FACTOR,
  type RankableCandidate,
  type EvidencePointer,
} from '../value-ranker.js';

const NOW = new Date('2026-04-16T12:00:00Z');

function cand(
  partial: Partial<RankableCandidate> & Pick<RankableCandidate, 'findingId' | 'tier2Files'>,
): RankableCandidate {
  return {
    experimentId: partial.experimentId ?? 'source-copy-lint',
    subject: partial.subject ?? null,
    ranAt: partial.ranAt ?? NOW.toISOString(),
    ...partial,
  };
}

describe('value-ranker — revenue proximity', () => {
  it('a revenue-observer finding outranks a generic copy-lint finding', () => {
    const ranked = rankCandidates({
      now: NOW,
      candidates: [
        cand({
          findingId: 'copy-1',
          experimentId: 'source-copy-lint',
          subject: 'copy:Agents.tsx',
          tier2Files: ['src/web/src/pages/Agents.tsx'],
        }),
        cand({
          findingId: 'rev-1',
          experimentId: 'attribution-observer',
          subject: 'attribution:rollup',
          tier2Files: ['src/self-bench/experiments/attribution-observer.ts'],
        }),
      ],
    });
    expect(ranked[0].candidate.findingId).toBe('rev-1');
    expect(ranked[0].breakdown.revenue_proximity).toBe(1);
    expect(ranked[1].breakdown.revenue_proximity).toBe(0);
  });

  it('subject prefix makes a finding revenue-proximal', () => {
    const ranked = rankCandidates({
      now: NOW,
      candidates: [
        cand({
          findingId: 'goal-1',
          experimentId: 'some-other-exp',
          subject: 'goal:mrr',
          tier2Files: ['src/web/src/pages/Other.tsx'],
        }),
      ],
    });
    expect(ranked[0].breakdown.revenue_proximity).toBe(1);
  });

  it('revenue-proximal path makes a finding revenue-proximal even with neutral subject', () => {
    const ranked = rankCandidates({
      now: NOW,
      candidates: [
        cand({
          findingId: 'p-1',
          experimentId: 'source-copy-lint',
          subject: 'copy:something',
          tier2Files: ['src/self-bench/experiments/outreach-thermostat.ts'],
        }),
      ],
    });
    expect(ranked[0].breakdown.revenue_proximity).toBe(1);
  });
});

describe('value-ranker — evidence strength', () => {
  it('multiple corroborating findings lift the score', () => {
    const candidate = cand({
      findingId: 'target',
      subject: 'copy:Dashboard.tsx',
      tier2Files: ['src/web/src/pages/Dashboard.tsx'],
    });
    const others: EvidencePointer[] = [
      { subject: 'copy:Dashboard.tsx', affectedFiles: ['src/web/src/pages/Dashboard.tsx'] },
      { subject: 'copy:Dashboard.tsx', affectedFiles: ['src/web/src/pages/Dashboard.tsx'] },
      { subject: null, affectedFiles: ['src/web/src/pages/Dashboard.tsx'] },
    ];
    const ranked = rankCandidates({ now: NOW, candidates: [candidate], otherFindings: others });
    expect(ranked[0].breakdown.evidence_strength).toBeGreaterThan(0);
    expect(ranked[0].rationale.some((r) => r.includes('evidence strength'))).toBe(true);
  });

  it('no corroborating evidence → zero evidence_strength', () => {
    const ranked = rankCandidates({
      now: NOW,
      candidates: [cand({ findingId: 'solo', tier2Files: ['src/a.ts'] })],
      otherFindings: [],
    });
    expect(ranked[0].breakdown.evidence_strength).toBe(0);
  });
});

describe('value-ranker — blast radius', () => {
  it('a tier-1 path carries a smaller blast-radius penalty than a tier-2 path', () => {
    const ranked = rankCandidates({
      now: NOW,
      candidates: [
        cand({
          findingId: 'tier1',
          tier2Files: ['src/self-bench/experiments/new-probe.ts'], // tier-1 under the experiments sandbox
        }),
        cand({
          findingId: 'tier2',
          tier2Files: ['src/web/src/pages/Dashboard.tsx'], // tier-2
        }),
      ],
    });
    const tier1 = ranked.find((r) => r.candidate.findingId === 'tier1')!;
    const tier2 = ranked.find((r) => r.candidate.findingId === 'tier2')!;
    expect(tier1.breakdown.blast_radius).toBeLessThan(tier2.breakdown.blast_radius);
  });
});

describe('value-ranker — recency', () => {
  it('a fresh finding outranks a stale one all else equal', () => {
    const fresh = cand({
      findingId: 'fresh',
      ranAt: NOW.toISOString(),
      tier2Files: ['src/a.ts'],
    });
    const stale = cand({
      findingId: 'stale',
      ranAt: new Date(NOW.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString(),
      tier2Files: ['src/a.ts'],
    });
    const ranked = rankCandidates({ now: NOW, candidates: [stale, fresh] });
    expect(ranked[0].candidate.findingId).toBe('fresh');
    expect(ranked[0].breakdown.recency).toBeGreaterThan(ranked[1].breakdown.recency);
  });

  it('findings older than 7d contribute no recency bonus', () => {
    const ranked = rankCandidates({
      now: NOW,
      candidates: [
        cand({
          findingId: 'very-old',
          ranAt: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
          tier2Files: ['src/a.ts'],
        }),
      ],
    });
    expect(ranked[0].breakdown.recency).toBe(0);
  });
});

describe('value-ranker — integration', () => {
  it('revenue-proximal finding beats copy-lint with more corroboration (weight check)', () => {
    const candidates = [
      cand({
        findingId: 'revenue',
        experimentId: 'attribution-observer',
        subject: 'attribution:rollup',
        tier2Files: ['src/self-bench/experiments/attribution-observer.ts'],
        ranAt: NOW.toISOString(),
      }),
      cand({
        findingId: 'copy',
        experimentId: 'source-copy-lint',
        subject: 'copy:Agents.tsx',
        tier2Files: ['src/web/src/pages/Agents.tsx'],
        ranAt: NOW.toISOString(),
      }),
    ];
    // Give the copy-lint finding 2 corroborating findings to verify
    // the +3 revenue weight still wins over the +2 * (2/5) evidence bonus.
    const others: EvidencePointer[] = [
      { subject: 'copy:Agents.tsx', affectedFiles: ['src/web/src/pages/Agents.tsx'] },
      { subject: 'copy:Agents.tsx', affectedFiles: ['src/web/src/pages/Agents.tsx'] },
    ];
    const ranked = rankCandidates({ now: NOW, candidates, otherFindings: others });
    expect(ranked[0].candidate.findingId).toBe('revenue');
  });

  it('rankCandidates is pure — calling twice on the same input yields identical ordering', () => {
    const input = {
      now: NOW,
      candidates: [
        cand({ findingId: 'a', tier2Files: ['src/a.ts'] }),
        cand({ findingId: 'b', tier2Files: ['src/b.ts'] }),
      ],
    };
    const r1 = rankCandidates(input);
    const r2 = rankCandidates(input);
    expect(r1.map((x) => x.candidate.findingId)).toEqual(r2.map((x) => x.candidate.findingId));
  });

  it('topRankedCandidate returns null for empty input', () => {
    expect(topRankedCandidate({ now: NOW, candidates: [] })).toBeNull();
  });

  it('breakdown + rationale explain the pick', () => {
    const ranked = rankCandidates({
      now: NOW,
      candidates: [
        cand({
          findingId: 'rev-1',
          experimentId: 'attribution-observer',
          subject: 'attribution:rollup',
          tier2Files: ['src/self-bench/experiments/attribution-observer.ts'],
        }),
      ],
    });
    expect(ranked[0].score).toBeGreaterThan(0);
    expect(ranked[0].rationale.join(' ')).toMatch(/revenue/);
  });
});

// -----------------------------------------------------------------------------
// Phase 5d — adaptive weights driven by lift-measurements outcomes.
// -----------------------------------------------------------------------------

describe('deriveAdaptiveWeights', () => {
  it('returns baseline unchanged when liftHealth is absent', () => {
    expect(deriveAdaptiveWeights(undefined)).toEqual(BASELINE_WEIGHTS);
  });

  it('returns baseline unchanged when samples < LIFT_HEALTH_MIN_SAMPLES', () => {
    const below = LIFT_HEALTH_MIN_SAMPLES - 1;
    expect(
      deriveAdaptiveWeights({ total_closed: below, moved_right: below, moved_wrong: 0 }),
    ).toEqual(BASELINE_WEIGHTS);
  });

  it('amplifies revenue_proximity + evidence_strength on a healthy loop', () => {
    const adapted = deriveAdaptiveWeights({
      total_closed: 10,
      moved_right: 8,
      moved_wrong: 2,
    });
    const net = (8 - 2) / 10; // 0.6
    const scale = 1 + ADAPTIVE_SCALE_FACTOR * net; // 1 + 0.3 = 1.3
    expect(adapted.revenue_proximity).toBeCloseTo(BASELINE_WEIGHTS.revenue_proximity * scale, 6);
    expect(adapted.evidence_strength).toBeCloseTo(BASELINE_WEIGHTS.evidence_strength * scale, 6);
    // Safety + operator + retention-policy components never scale.
    expect(adapted.blast_radius).toBe(BASELINE_WEIGHTS.blast_radius);
    expect(adapted.priority_match).toBe(BASELINE_WEIGHTS.priority_match);
    expect(adapted.recency).toBe(BASELINE_WEIGHTS.recency);
  });

  it('damps revenue_proximity + evidence_strength on a regressive loop', () => {
    const adapted = deriveAdaptiveWeights({
      total_closed: 10,
      moved_right: 2,
      moved_wrong: 8,
    });
    const net = (2 - 8) / 10; // -0.6
    const scale = 1 + ADAPTIVE_SCALE_FACTOR * net; // 1 - 0.3 = 0.7
    expect(adapted.revenue_proximity).toBeCloseTo(BASELINE_WEIGHTS.revenue_proximity * scale, 6);
    expect(adapted.evidence_strength).toBeCloseTo(BASELINE_WEIGHTS.evidence_strength * scale, 6);
  });

  it('clamps scale into [0.5, 1.5] even at perfect-wrong / perfect-right extremes', () => {
    // ADAPTIVE_SCALE_FACTOR=0.5 × net_ratio∈[-1,+1] gives [0.5, 1.5] on
    // the multiplier. The weight never flips sign or disappears — data
    // nudges the prior, doesn't overwrite it.
    const allRight = deriveAdaptiveWeights({ total_closed: 10, moved_right: 10, moved_wrong: 0 });
    expect(allRight.revenue_proximity).toBeCloseTo(BASELINE_WEIGHTS.revenue_proximity * 1.5, 6);
    const allWrong = deriveAdaptiveWeights({ total_closed: 10, moved_right: 0, moved_wrong: 10 });
    expect(allWrong.revenue_proximity).toBeCloseTo(BASELINE_WEIGHTS.revenue_proximity * 0.5, 6);
  });
});

describe('rankCandidates with liftHealth', () => {
  it('preserves baseline behavior when liftHealth is absent (dormant skeleton)', () => {
    const candidates = [
      cand({
        findingId: 'rev-1',
        experimentId: 'attribution-observer',
        subject: 'attribution:rollup',
        tier2Files: ['src/self-bench/experiments/attribution-observer.ts'],
      }),
    ];
    const withoutHealth = rankCandidates({ now: NOW, candidates });
    const withThinData = rankCandidates({
      now: NOW,
      candidates,
      liftHealth: { total_closed: 2, moved_right: 1, moved_wrong: 1 },
    });
    // <5 samples → same scores as no liftHealth at all.
    expect(withoutHealth[0].score).toBe(withThinData[0].score);
  });

  it('amplifies a revenue-proximal candidate score under a healthy lift signal', () => {
    const candidates = [
      cand({
        findingId: 'rev-1',
        experimentId: 'attribution-observer',
        subject: 'attribution:rollup',
        tier2Files: ['src/self-bench/experiments/attribution-observer.ts'],
      }),
    ];
    const baseline = rankCandidates({ now: NOW, candidates });
    const healthy = rankCandidates({
      now: NOW,
      candidates,
      liftHealth: { total_closed: 10, moved_right: 8, moved_wrong: 2 },
    });
    // Healthy loop: revenue_proximity component is amplified, score is higher.
    expect(healthy[0].score).toBeGreaterThan(baseline[0].score);
  });

  it('damps a revenue-proximal candidate score under a regressive lift signal', () => {
    const candidates = [
      cand({
        findingId: 'rev-1',
        experimentId: 'attribution-observer',
        subject: 'attribution:rollup',
        tier2Files: ['src/self-bench/experiments/attribution-observer.ts'],
      }),
    ];
    const baseline = rankCandidates({ now: NOW, candidates });
    const regressive = rankCandidates({
      now: NOW,
      candidates,
      liftHealth: { total_closed: 10, moved_right: 2, moved_wrong: 8 },
    });
    expect(regressive[0].score).toBeLessThan(baseline[0].score);
  });
});
