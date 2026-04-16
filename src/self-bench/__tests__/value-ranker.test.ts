import { describe, it, expect } from 'vitest';
import {
  rankCandidates,
  topRankedCandidate,
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
