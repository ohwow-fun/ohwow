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

const { XDraftDistillerScheduler, buildPrompt, sanitizeDraft, hasExternalSignal, hasConcreteContent, MARKET_SUBJECT_PREFIX } = await import(
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
  it('threads subject, summary, and diff lines through as source material', () => {
    const prompt = buildPrompt(
      makeInsight({
        subject: 'market:linear.app/pricing',
        summary: 'Pricing page drifted',
        evidence: {
          url: 'https://linear.app/pricing',
          change_kind: 'changed',
          diff: { added: ['Pro $12/mo'], removed: ['Pro $9/mo'], truncated: false },
        },
      }),
    );
    expect(prompt).toContain('market:linear.app/pricing');
    expect(prompt).toContain('Pricing page drifted');
    expect(prompt).toContain('+ Pro $12/mo');
    expect(prompt).toContain('- Pro $9/mo');
    expect(prompt).toContain('https://linear.app/pricing');
  });

  it('keeps mechanism vocabulary out of the evidence block so the model does not parrot it', () => {
    // The older bad posts opened with "the verdict flipped..." because
    // the prompt labelled evidence fields with the internal terms.
    // The evidence section must not name change_kind or novelty_reason.
    const prompt = buildPrompt(
      makeInsight({
        novelty_reason: 'verdict_flipped',
        evidence: {
          url: 'https://example.com',
          change_kind: 'changed',
          diff: { added: ['hello'], removed: [], truncated: false },
        },
      }),
    );
    // Locate the evidence section and assert internal labels aren't in it.
    const evidenceBlock = prompt.slice(prompt.indexOf('Evidence:'));
    expect(evidenceBlock).not.toMatch(/change_kind/);
    expect(evidenceBlock).not.toMatch(/novelty_reason/);
    expect(evidenceBlock).not.toMatch(/verdict_flipped/);
  });

  it('invites SKIP when evidence is thin so the model can refuse to draft', () => {
    const prompt = buildPrompt(makeInsight({}));
    expect(prompt).toMatch(/SKIP/);
  });
});

describe('sanitizeDraft', () => {
  it('returns null when the model replies SKIP', () => {
    expect(sanitizeDraft('SKIP')).toBeNull();
    expect(sanitizeDraft('skip')).toBeNull();
    expect(sanitizeDraft('  SKIP.  ')).toBeNull();
    expect(sanitizeDraft('"SKIP"')).toBeNull();
  });

  it('returns the post body when the model writes something real', () => {
    expect(sanitizeDraft('Linear quietly bumped Pro to $12')).toBe(
      'Linear quietly bumped Pro to $12',
    );
  });

  // INTEL_LEAK_PHRASES scrub — Phase: deprecate X channel / content-gen prompts fix
  it('returns null for drafts containing "verdict flipped" (internal vocab leak)', () => {
    expect(sanitizeDraft('Interesting: the verdict flipped on their pricing page.')).toBeNull();
  });

  it('returns null for drafts containing "latest scan" (internal vocab leak)', () => {
    expect(sanitizeDraft('Our latest scan of linear.app turned up a price change.')).toBeNull();
  });

  it("returns null for drafts containing \"we've been watching\" (internal vocab leak)", () => {
    expect(sanitizeDraft("We've been watching this company for a while — it moved.")).toBeNull();
  });

  it('INTEL_LEAK phrase check is case-insensitive', () => {
    expect(sanitizeDraft('VERDICT FLIPPED on the pricing page.')).toBeNull();
    expect(sanitizeDraft('Latest Scan shows new tiers.')).toBeNull();
    expect(sanitizeDraft("WE'VE BEEN WATCHING this space.")).toBeNull();
  });

  it('does not reject drafts that do not contain any banned phrase', () => {
    const clean = 'Linear raised Pro from $9 to $12. Small bump with a real margin play behind it';
    expect(sanitizeDraft(clean)).toBe(clean);
  });
});

describe('hasExternalSignal', () => {
  it('accepts findings with a real content diff', () => {
    expect(
      hasExternalSignal(
        makeInsight({
          evidence: {
            url: 'https://x',
            change_kind: 'changed',
            diff: { added: ['something'], removed: [], truncated: false },
          },
        }),
      ),
    ).toBe(true);
  });

  it('rejects unchanged findings — the "verdict flipped on static content" noise', () => {
    expect(
      hasExternalSignal(
        makeInsight({
          evidence: {
            url: 'https://x',
            change_kind: 'unchanged',
            diff: { added: [], removed: [], truncated: false },
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects changed findings whose diff is empty', () => {
    expect(
      hasExternalSignal(
        makeInsight({
          evidence: {
            url: 'https://x',
            change_kind: 'changed',
            diff: { added: [], removed: [], truncated: false },
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects first_seen findings — opening our eyes is not an event', () => {
    expect(
      hasExternalSignal(
        makeInsight({
          evidence: { url: 'https://x', change_kind: 'first_seen' },
        }),
      ),
    ).toBe(false);
  });
});

describe('XDraftDistillerScheduler filter integration', () => {
  it('skips insights without an external signal without calling the LLM', async () => {
    listMock.mockResolvedValue([
      makeInsight({
        latest_finding_id: 'f-noise',
        evidence: {
          url: 'https://x',
          change_kind: 'unchanged',
          diff: { added: [], removed: [], truncated: false },
        },
      }),
    ]);
    findMock.mockResolvedValue(null);
    const draftMock = vi.fn();
    insertMock.mockResolvedValue(null);

    const scheduler = new XDraftDistillerScheduler({} as never, null, 'ws-1', {
      draftTweet: draftMock,
    });
    const stats = await scheduler.tick();

    expect(stats.considered).toBe(1);
    expect(stats.drafted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(draftMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });
});

// ── Criteria freeze: content-quality filter (hasConcreteContent + ANGLE gate) ──
// These tests pin the 6 criteria from the QA plan for the pre-LLM content
// quality filter introduced in c5b1780.

describe('hasConcreteContent — criterion 1: low-signal "no changes" diff returns false', () => {
  it('returns false when every added line matches a low-signal pattern', () => {
    // Criterion 1: the "no changes detected" boilerplate line is a known
    // low-signal pattern; a finding whose entire diff is this line must be
    // dropped before the LLM call fires.
    expect(
      hasConcreteContent(
        makeInsight({
          evidence: {
            change_kind: 'changed',
            diff: { added: ['no changes detected'], removed: [] },
          },
        }),
      ),
    ).toBe(false);
  });

  it('also returns false for other known low-signal phrases (variant coverage)', () => {
    const lowSignalLines = [
      'No new releases',
      'no updates',
      'Nothing new',
      'unchanged',
      'No activity',
      'No commits',
      'No modifications',
    ];
    for (const line of lowSignalLines) {
      expect(
        hasConcreteContent(
          makeInsight({
            evidence: {
              change_kind: 'changed',
              diff: { added: [line], removed: [] },
            },
          }),
        ),
        `expected false for low-signal line: "${line}"`,
      ).toBe(false);
    }
  });
});

describe('hasConcreteContent — criterion 2: real named content returns true', () => {
  it('returns true when the diff contains a concrete named change', () => {
    // Criterion 2: a diff with real version info and a feature description is
    // concrete content — the LLM should be allowed to draft from it.
    expect(
      hasConcreteContent(
        makeInsight({
          evidence: {
            change_kind: 'changed',
            diff: {
              added: ['Open WebUI 0.6.2 released', 'New feature: model switching'],
              removed: [],
            },
          },
        }),
      ),
    ).toBe(true);
  });
});

describe('hasConcreteContent — edge cases', () => {
  it('returns false when change_kind is not "changed"', () => {
    expect(
      hasConcreteContent(
        makeInsight({
          evidence: { change_kind: 'unchanged', diff: { added: ['Open WebUI 0.6.2'], removed: [] } },
        }),
      ),
    ).toBe(false);
  });

  it('returns false when diff is empty (both arrays empty)', () => {
    expect(
      hasConcreteContent(
        makeInsight({ evidence: { change_kind: 'changed', diff: { added: [], removed: [] } } }),
      ),
    ).toBe(false);
  });

  it('returns true when only the removed side has concrete content', () => {
    expect(
      hasConcreteContent(
        makeInsight({
          evidence: {
            change_kind: 'changed',
            diff: { added: [], removed: ['Pro plan $9/month removed'] },
          },
        }),
      ),
    ).toBe(true);
  });

  it('returns true when mixed lines contain at least one non-low-signal line', () => {
    expect(
      hasConcreteContent(
        makeInsight({
          evidence: {
            change_kind: 'changed',
            diff: { added: ['no changes detected', 'Open WebUI 0.6.2 released'], removed: [] },
          },
        }),
      ),
    ).toBe(true);
  });
});

describe('extractNamedEntity (via buildPrompt) — criterion 3', () => {
  it('surfaces the version-bearing line as "Named entity:" in the evidence block', () => {
    // Criterion 3: extractNamedEntity is private, but its output is prepended
    // to the evidence summary as "Named entity: <line>". This test verifies
    // the named-entity extraction fires and picks the right line.
    const prompt = buildPrompt(
      makeInsight({
        evidence: {
          change_kind: 'changed',
          diff: { added: ['Open WebUI 0.6.2 released'], removed: [] },
        },
      }),
    );
    expect(prompt).toContain('Named entity: Open WebUI 0.6.2 released');
  });

  it('does not add a Named entity line when there is no version string or proper noun', () => {
    const prompt = buildPrompt(
      makeInsight({
        evidence: {
          change_kind: 'changed',
          diff: { added: ['something changed here'], removed: [] },
        },
      }),
    );
    expect(prompt).not.toContain('Named entity:');
  });
});

describe('buildPrompt — criterion 4: ANGLE gate present', () => {
  it('contains "ANGLE:" in the prompt instruction block', () => {
    // Criterion 4: the ANGLE scratchpad gate must appear in the pre-writing
    // instructions so the model is directed to derive an implication before
    // writing. Its absence would mean the gate was accidentally deleted.
    const prompt = buildPrompt(makeInsight({}));
    expect(prompt).toContain('ANGLE:');
  });

  it('instructs the model that the ANGLE line must not appear in the final post', () => {
    const prompt = buildPrompt(makeInsight({}));
    expect(prompt).toMatch(/ANGLE.*must NOT appear in the final post/i);
  });
});

describe('sanitizeDraft — ANGLE line stripping', () => {
  it('strips an ANGLE: scratchpad line leaked by the model before the actual post', () => {
    const raw = 'ANGLE: builders now have easier model-switching\nLinear quietly bumped Pro to $12';
    const result = sanitizeDraft(raw);
    expect(result).not.toMatch(/^ANGLE:/im);
    expect(result).toContain('Linear quietly bumped Pro to $12');
  });

  it('strips ANGLE: line regardless of case', () => {
    // Use a body that passes voiceCheck (no trailing punctuation issues, no intel-leak phrases)
    const raw = 'angle: some internal note\nLinear raised Pro from $9 to $12';
    const result = sanitizeDraft(raw);
    // result must not be null (body is voice-clean after stripping the angle line)
    expect(result).not.toBeNull();
    // The angle line must not be in the output
    expect(result).not.toContain('angle:');
    expect(result).toContain('Linear raised Pro from $9 to $12');
  });
});

describe('tick() — criterion 5: low-signal diff skipped without LLM call', () => {
  it('increments skipped and never calls draftTweet for a finding whose diff is all low-signal', async () => {
    // Criterion 5: a finding that passes hasExternalSignal (change_kind=changed,
    // non-empty diff) but fails hasConcreteContent (every line matches a
    // low-signal pattern) must be skipped before the LLM call fires.
    listMock.mockResolvedValue([
      makeInsight({
        subject: 'market:open-webui/releases',
        latest_finding_id: 'f-lowsignal',
        evidence: {
          url: 'https://github.com/open-webui/open-webui/releases',
          change_kind: 'changed',
          // Non-empty diff so hasExternalSignal passes, but every line is low-signal
          // so hasConcreteContent must gate it out.
          diff: { added: ['no changes detected'], removed: [] },
        },
      }),
    ]);
    findMock.mockResolvedValue(null);
    const draftTweetMock = vi.fn();
    insertMock.mockResolvedValue(null);

    const scheduler = new XDraftDistillerScheduler({} as never, null, 'ws-1', {
      draftTweet: draftTweetMock,
    });
    const stats = await scheduler.tick();

    // considered = 1 (market: subject passed the prefix filter)
    expect(stats.considered).toBe(1);
    // drafted = 0, skipped = 1 (dropped by hasConcreteContent)
    expect(stats.drafted).toBe(0);
    expect(stats.skipped).toBe(1);
    // The LLM must never have been called.
    expect(draftTweetMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });
});
