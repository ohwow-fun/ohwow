import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExperimentContext, Finding } from '../experiment-types.js';
import type { ScraplingResponse } from '../../execution/scrapling/scrapling-types.js';

const fetchMock = vi.fn();
const cleanMock = vi.fn();

vi.mock('../../execution/scrapling/index.js', () => ({
  autoEscalateFetch: (...args: unknown[]) => fetchMock(...args),
  cleanContent: (...args: unknown[]) => cleanMock(...args),
}));

const { ScrapeDiffProbeExperiment } = await import('../experiments/scrape-diff-probe.js');

function buildCtx(prior: Finding[] = []): ExperimentContext {
  return {
    db: {} as never,
    workspaceId: 'ws-1',
    workspaceSlug: 'default',
    engine: {} as never,
    recentFindings: async () => prior,
    scraplingService: {} as never,
  };
}

function makePriorFinding(partial: Partial<Finding>): Finding {
  return {
    id: partial.id ?? 'f-1',
    experimentId: partial.experimentId ?? 'scrape-diff:test',
    category: 'business_outcome',
    subject: partial.subject ?? 'market:example.com',
    hypothesis: null,
    verdict: partial.verdict ?? 'pass',
    summary: partial.summary ?? 'prev',
    evidence: partial.evidence ?? {},
    interventionApplied: null,
    ranAt: partial.ranAt ?? '2026-04-16T00:00:00Z',
    durationMs: 0,
    status: 'active',
    supersededBy: null,
    createdAt: partial.createdAt ?? '2026-04-16T00:00:00Z',
  };
}

const baseConfig = {
  id: 'scrape-diff:test',
  name: 'Test probe',
  url: 'https://example.com/pricing',
  subjectKey: 'market:example.com',
  category: 'business_outcome' as const,
};

beforeEach(() => {
  fetchMock.mockReset();
  cleanMock.mockReset();
});

describe('ScrapeDiffProbeExperiment construction', () => {
  it('rejects invalid category (data_freshness bug guard)', () => {
    expect(
      () =>
        new ScrapeDiffProbeExperiment({
          ...baseConfig,
          category: 'data_freshness' as never,
        }),
    ).toThrow(/invalid category/);
  });

  it('rejects empty id / url / subjectKey', () => {
    expect(() => new ScrapeDiffProbeExperiment({ ...baseConfig, id: '' })).toThrow();
    expect(() => new ScrapeDiffProbeExperiment({ ...baseConfig, url: '' })).toThrow();
    expect(
      () => new ScrapeDiffProbeExperiment({ ...baseConfig, subjectKey: '' }),
    ).toThrow();
  });

  it('defaults cadence to 6h and runOnBoot=false', () => {
    const exp = new ScrapeDiffProbeExperiment(baseConfig);
    expect(exp.cadence.everyMs).toBe(6 * 60 * 60 * 1000);
    expect(exp.cadence.runOnBoot).toBe(false);
  });
});

describe('ScrapeDiffProbeExperiment probe', () => {
  const mockResponse: ScraplingResponse = {
    url: 'https://example.com/pricing',
    status: 200,
    html: '<html><body>Pro $9/mo Team $29/mo</body></html>',
  };

  function stubFetch(text: string) {
    fetchMock.mockResolvedValue({
      response: mockResponse,
      tier: 'fast',
      escalated: false,
    });
    cleanMock.mockReturnValue(text);
  }

  it('first run with no prior finding → pass with first_seen', async () => {
    const exp = new ScrapeDiffProbeExperiment(baseConfig);
    stubFetch('Pro $9/mo\nTeam $29/mo');
    const ctx = buildCtx([]);

    const result = await exp.probe(ctx);
    expect(result.subject).toBe('market:example.com');
    expect((result.evidence as { change_kind: string }).change_kind).toBe('first_seen');
    expect((result.evidence as { content_hash: string }).content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('second run with unchanged content → pass with unchanged', async () => {
    const exp = new ScrapeDiffProbeExperiment(baseConfig);
    const text = 'Pro $9/mo\nTeam $29/mo';
    stubFetch(text);

    const first = await exp.probe(buildCtx([]));
    const firstHash = (first.evidence as { content_hash: string }).content_hash;

    const prior = makePriorFinding({
      evidence: {
        change_kind: 'first_seen',
        content_hash: firstHash,
        normalized_snapshot: 'Pro $9/mo\nTeam $29/mo',
      },
    });
    const second = await exp.probe(buildCtx([prior]));
    expect((second.evidence as { change_kind: string }).change_kind).toBe('unchanged');
    expect(exp.judge(second, [])).toBe('pass');
  });

  it('third run with changed content → warning with diff', async () => {
    const exp = new ScrapeDiffProbeExperiment(baseConfig);
    stubFetch('Pro $12/mo\nTeam $29/mo\nEnterprise $99/mo');

    const prior = makePriorFinding({
      evidence: {
        change_kind: 'first_seen',
        content_hash: 'deadbeef'.repeat(8), // not equal to the new hash
        normalized_snapshot: 'Pro $9/mo\nTeam $29/mo',
      },
    });
    const result = await exp.probe(buildCtx([prior]));

    const ev = result.evidence as {
      change_kind: string;
      diff: { added: string[]; removed: string[]; truncated: boolean };
    };
    expect(ev.change_kind).toBe('changed');
    expect(ev.diff.added).toContain('Pro $12/mo');
    expect(ev.diff.added).toContain('Enterprise $99/mo');
    expect(ev.diff.removed).toContain('Pro $9/mo');
    expect(ev.diff.truncated).toBe(false);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('diff is capped at 40 lines per side', async () => {
    const exp = new ScrapeDiffProbeExperiment(baseConfig);
    const newText = Array.from({ length: 100 }, (_, i) => `new-${i}`).join('\n');
    stubFetch(newText);
    const priorText = Array.from({ length: 100 }, (_, i) => `old-${i}`).join('\n');
    const prior = makePriorFinding({
      evidence: {
        change_kind: 'first_seen',
        content_hash: 'x'.repeat(64),
        normalized_snapshot: priorText,
      },
    });
    const result = await exp.probe(buildCtx([prior]));
    const ev = result.evidence as {
      diff: { added: string[]; removed: string[]; truncated: boolean };
    };
    expect(ev.diff.added.length).toBe(40);
    expect(ev.diff.removed.length).toBe(40);
    expect(ev.diff.truncated).toBe(true);
  });

  it('forwards selector to the scraper', async () => {
    const exp = new ScrapeDiffProbeExperiment({
      ...baseConfig,
      selector: '.pricing-table',
    });
    stubFetch('Pro $9/mo');
    await exp.probe(buildCtx([]));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.anything(),
      baseConfig.url,
      expect.objectContaining({ selector: '.pricing-table' }),
    );
  });

  it('fetch error returns fail verdict with error in evidence', async () => {
    const exp = new ScrapeDiffProbeExperiment(baseConfig);
    fetchMock.mockResolvedValue({
      tier: 'fast',
      escalated: false,
      error: 'ECONNREFUSED',
    });
    const result = await exp.probe(buildCtx([]));
    const ev = result.evidence as { change_kind: string; error?: string };
    expect(ev.change_kind).toBe('error');
    expect(ev.error).toContain('ECONNREFUSED');
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('missing scraplingService returns fail verdict', async () => {
    const exp = new ScrapeDiffProbeExperiment(baseConfig);
    const ctx: ExperimentContext = {
      ...buildCtx([]),
      scraplingService: undefined,
    };
    const result = await exp.probe(ctx);
    expect((result.evidence as { change_kind: string }).change_kind).toBe('error');
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('ignores prior findings for other subjects', async () => {
    const exp = new ScrapeDiffProbeExperiment(baseConfig);
    stubFetch('Pro $9/mo');
    const stalePrior = makePriorFinding({
      subject: 'market:other.com',
      evidence: {
        change_kind: 'first_seen',
        content_hash: 'stale'.repeat(13),
        normalized_snapshot: 'other content',
      },
    });
    const result = await exp.probe(buildCtx([stalePrior]));
    expect((result.evidence as { change_kind: string }).change_kind).toBe('first_seen');
  });

  it('skips prior error findings when looking up the baseline', async () => {
    const exp = new ScrapeDiffProbeExperiment(baseConfig);
    stubFetch('Pro $9/mo');
    const errorPrior = makePriorFinding({
      verdict: 'fail',
      evidence: {
        change_kind: 'error',
        content_hash: '',
        normalized_snapshot: '',
        error: 'scrape failed',
      },
    });
    const result = await exp.probe(buildCtx([errorPrior]));
    expect((result.evidence as { change_kind: string }).change_kind).toBe('first_seen');
  });
});
