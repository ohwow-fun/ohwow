import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DistilledInsight } from '../../self-bench/insight-distiller.js';
import {
  _resetRuntimeConfigCacheForTests,
  _seedRuntimeConfigCacheForTests,
} from '../../self-bench/runtime-config.js';

const listMock = vi.fn();
const findMock = vi.fn();
const insertMock = vi.fn();

vi.mock('../../self-bench/insight-distiller.js', () => ({
  listDistilledInsights: (...args: unknown[]) => listMock(...(args as [])),
}));

vi.mock('../x-draft-store.js', () => ({
  findDraftByFindingId: (...args: unknown[]) => findMock(...args),
  insertDraft: (...args: unknown[]) => insertMock(...args),
}));

const { XDraftDistillerScheduler, buildPrompt, MARKET_SUBJECT_PREFIX } = await import(
  '../x-draft-distiller.js'
);

function makeInsight(partial: Partial<DistilledInsight>): DistilledInsight {
  return {
    cluster_id: partial.cluster_id ?? 'scrape-diff:linear-pricing::market:linear.app/pricing',
    experiment_id: partial.experiment_id ?? 'scrape-diff:linear-pricing',
    subject: partial.subject ?? 'market:linear.app/pricing',
    latest_finding_id: partial.latest_finding_id ?? 'f-1',
    verdict: partial.verdict ?? 'warning',
    summary: partial.summary ?? 'Content drift on market:linear.app/pricing: +2/-1 lines.',
    novelty_score: partial.novelty_score ?? 0.9,
    novelty_reason: partial.novelty_reason ?? 'verdict_flipped',
    novelty_detail: null,
    z_score: null,
    consecutive_fails: 0,
    sample_count: 2,
    first_seen_at: '2026-04-15T00:00:00Z',
    last_seen_at: '2026-04-16T00:00:00Z',
    tracked_field: 'content_hash',
    last_value: null,
    running_mean: null,
    evidence: partial.evidence ?? {
      url: 'https://linear.app/pricing',
      change_kind: 'changed',
      diff: { added: ['Pro $12/mo'], removed: ['Pro $9/mo'], truncated: false },
    },
  };
}

beforeEach(() => {
  listMock.mockReset();
  findMock.mockReset();
  insertMock.mockReset();
  _resetRuntimeConfigCacheForTests();
});

describe('XDraftDistillerScheduler', () => {
  it('drafts one tweet per market insight with no prior draft', async () => {
    listMock.mockResolvedValue([
      makeInsight({ subject: 'market:linear.app/pricing', latest_finding_id: 'f-1' }),
      makeInsight({ subject: 'market:n8n.io/pricing', latest_finding_id: 'f-2' }),
    ]);
    findMock.mockResolvedValue(null);
    insertMock.mockImplementation(async (_db, { sourceFindingId }) => ({
      id: `draft-${sourceFindingId}`,
      workspace_id: 'ws-1',
      body: 'body',
      source_finding_id: sourceFindingId,
      status: 'pending',
      created_at: 'now',
      approved_at: null,
      rejected_at: null,
    }));

    const scheduler = new XDraftDistillerScheduler({} as never, null, 'ws-1', {
      draftTweet: async (i) => `Tweet about ${i.subject}`,
    });
    const stats = await scheduler.tick();

    expect(stats.considered).toBe(2);
    expect(stats.drafted).toBe(2);
    expect(insertMock).toHaveBeenCalledTimes(2);
  });

  it(`filters to subjects starting with "${MARKET_SUBJECT_PREFIX}"`, async () => {
    listMock.mockResolvedValue([
      makeInsight({ subject: 'market:linear.app/pricing' }),
      makeInsight({ subject: 'dm_intel:someone', latest_finding_id: 'f-dm' }),
      makeInsight({ subject: 'internal:burn-rate', latest_finding_id: 'f-burn' }),
    ]);
    findMock.mockResolvedValue(null);
    insertMock.mockResolvedValue({ id: 'draft-x' });

    const scheduler = new XDraftDistillerScheduler({} as never, null, 'ws-1', {
      draftTweet: async () => 'tweet',
    });
    const stats = await scheduler.tick();

    expect(stats.considered).toBe(1);
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('skips insights with a prior draft (idempotent)', async () => {
    listMock.mockResolvedValue([
      makeInsight({ subject: 'market:linear.app/pricing', latest_finding_id: 'f-1' }),
    ]);
    findMock.mockResolvedValue({
      id: 'draft-existing',
      workspace_id: 'ws-1',
      body: 'already drafted',
      source_finding_id: 'f-1',
      status: 'pending',
      created_at: 'now',
      approved_at: null,
      rejected_at: null,
    });
    insertMock.mockResolvedValue(null);

    const scheduler = new XDraftDistillerScheduler({} as never, null, 'ws-1', {
      draftTweet: async () => 'tweet',
    });
    const stats = await scheduler.tick();

    expect(stats.drafted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('skips empty LLM output', async () => {
    listMock.mockResolvedValue([makeInsight({})]);
    findMock.mockResolvedValue(null);

    const scheduler = new XDraftDistillerScheduler({} as never, null, 'ws-1', {
      draftTweet: async () => '   ',
    });
    const stats = await scheduler.tick();

    expect(stats.drafted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('no-op on empty insight list', async () => {
    listMock.mockResolvedValue([]);
    const scheduler = new XDraftDistillerScheduler({} as never, null, 'ws-1', {
      draftTweet: async () => 'tweet',
    });
    const stats = await scheduler.tick();
    expect(stats).toEqual({ considered: 0, drafted: 0, skipped: 0 });
    expect(findMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('counts insert failures as skipped', async () => {
    listMock.mockResolvedValue([makeInsight({})]);
    findMock.mockResolvedValue(null);
    insertMock.mockResolvedValue(null); // db rejected

    const scheduler = new XDraftDistillerScheduler({} as never, null, 'ws-1', {
      draftTweet: async () => 'tweet',
    });
    const stats = await scheduler.tick();
    expect(stats.drafted).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  it('listDistilledInsights is called with minScore=0.7 and limit=5 by default', async () => {
    listMock.mockResolvedValue([]);
    const scheduler = new XDraftDistillerScheduler({} as never, null, 'ws-1', {
      draftTweet: async () => 'x',
    });
    await scheduler.tick();
    expect(listMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ minScore: 0.7, limit: 5 }),
    );
  });

  it('passes subjectPrefix="market:" so the top-N is drawn from the market population only', async () => {
    // Upstream-starvation regression: the scheduler must push the
    // subject-shape filter down into listDistilledInsights, otherwise
    // high-novelty digest/ops rows at novelty 1.0 consume the entire
    // 5-row window and no market cluster is ever considered.
    listMock.mockResolvedValue([]);
    const scheduler = new XDraftDistillerScheduler({} as never, null, 'ws-1', {
      draftTweet: async () => 'x',
    });
    await scheduler.tick();
    expect(listMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subjectPrefix: MARKET_SUBJECT_PREFIX }),
    );
  });

  it('reads x_draft_distiller_min_score from runtime_config_overrides per tick, falling back to the ctor value when unset', async () => {
    listMock.mockResolvedValue([]);
    const scheduler = new XDraftDistillerScheduler({} as never, null, 'ws-1', {
      minScore: 0.7,
      draftTweet: async () => 'x',
    });

    // First tick: no override set — should use the ctor value.
    await scheduler.tick();
    expect(listMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ minScore: 0.7 }),
    );

    // Seed an override, simulating an experiment writing to
    // runtime_config_overrides. Next tick must pick it up live.
    _seedRuntimeConfigCacheForTests('x_draft_distiller_min_score', 0.55);
    await scheduler.tick();
    expect(listMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ minScore: 0.55 }),
    );

    // String-shaped values (as stored in the JSON column) must coerce.
    _seedRuntimeConfigCacheForTests('x_draft_distiller_min_score', '0.4');
    await scheduler.tick();
    expect(listMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ minScore: 0.4 }),
    );

    // Non-numeric override falls back to the ctor value.
    _seedRuntimeConfigCacheForTests('x_draft_distiller_min_score', 'not-a-number');
    await scheduler.tick();
    expect(listMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ minScore: 0.7 }),
    );
  });
});

describe('buildPrompt', () => {
  it('includes subject, summary, novelty reason, and diff lines', () => {
    const prompt = buildPrompt(
      makeInsight({
        subject: 'market:linear.app/pricing',
        summary: 'Pricing page drifted',
        novelty_reason: 'verdict_flipped',
        evidence: {
          url: 'https://linear.app/pricing',
          change_kind: 'changed',
          diff: { added: ['Pro $12/mo'], removed: ['Pro $9/mo'], truncated: false },
        },
      }),
    );
    expect(prompt).toContain('market:linear.app/pricing');
    expect(prompt).toContain('Pricing page drifted');
    expect(prompt).toContain('verdict_flipped');
    expect(prompt).toContain('+ Pro $12/mo');
    expect(prompt).toContain('- Pro $9/mo');
    expect(prompt).toContain('https://linear.app/pricing');
  });

  it('forbids pitch CTAs and corporate voice in its instructions', () => {
    const prompt = buildPrompt(makeInsight({}));
    expect(prompt).toMatch(/NO call-to-action/i);
    expect(prompt).toMatch(/NO product pitch/i);
  });
});
