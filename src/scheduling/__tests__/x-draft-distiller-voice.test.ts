/**
 * Freeze tests for the X deprecation + intel-leak phrase hardening round.
 *
 * Criteria under test:
 *  1. buildPrompt() includes STANCE/FORBIDDEN from buildVoicePrinciples
 *  2. buildPrompt() includes platform capacity from buildLengthDirective
 *  3. sanitizeDraft() rejects text containing "no changes observed"
 *  4. sanitizeDraft() rejects text containing "we observed"
 *  5. voiceCheck() rejects text containing "the verdict"
 *  6. voiceCheck() rejects text containing "scanning"
 *  7. voiceCheck() rejects text containing "unchanged"
 */

import { describe, it, expect, vi } from 'vitest';
import type { DistilledInsight } from '../../self-bench/insight-distiller.js';

// Mock heavy deps so this test has no I/O footprint.
vi.mock('../../self-bench/insight-distiller.js', () => ({
  listDistilledInsights: vi.fn(),
}));
vi.mock('../x-draft-store.js', () => ({
  findDraftByFindingId: vi.fn(),
  insertDraft: vi.fn(),
}));

const { buildPrompt, sanitizeDraft } = await import('../x-draft-distiller.js');
const { voiceCheck } = await import('../../lib/voice/voice-core.js');

function makeInsight(partial: Partial<DistilledInsight> = {}): DistilledInsight {
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

// ---------------------------------------------------------------------------
// Criterion 1 — buildPrompt() includes voice principles (STANCE + FORBIDDEN)
// ---------------------------------------------------------------------------

describe('buildPrompt — buildVoicePrinciples output present', () => {
  it('includes STANCE: section from buildVoicePrinciples', () => {
    const prompt = buildPrompt(makeInsight());
    expect(prompt).toContain('STANCE:');
  });

  it('includes FORBIDDEN: section from buildVoicePrinciples', () => {
    const prompt = buildPrompt(makeInsight());
    expect(prompt).toContain('FORBIDDEN:');
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — buildPrompt() includes platform capacity from buildLengthDirective
// ---------------------------------------------------------------------------

describe('buildPrompt — buildLengthDirective output present', () => {
  it('includes "hard cap 280" for x/post context', () => {
    const prompt = buildPrompt(makeInsight());
    expect(prompt).toContain('hard cap 280');
  });

  it('includes LENGTH: directive label', () => {
    const prompt = buildPrompt(makeInsight());
    expect(prompt).toContain('LENGTH:');
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — sanitizeDraft() rejects "no changes observed"
// ---------------------------------------------------------------------------

describe('sanitizeDraft — rejects new INTEL_LEAK_PHRASES', () => {
  it('returns null for a draft containing "no changes observed"', () => {
    expect(sanitizeDraft('Price watch: no changes observed on the pricing page.')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Criterion 4 — sanitizeDraft() rejects "we observed"
  // ---------------------------------------------------------------------------

  it('returns null for a draft containing "we observed"', () => {
    expect(sanitizeDraft('We observed a shift in their pricing tier structure.')).toBeNull();
  });

  it('phrase rejection is case-insensitive for "no changes"', () => {
    expect(sanitizeDraft('NO CHANGES detected on the roadmap.')).toBeNull();
  });

  it('phrase rejection is case-insensitive for "we observed"', () => {
    expect(sanitizeDraft('WE OBSERVED a 20% price bump here.')).toBeNull();
  });

  it('does not reject drafts that do not contain banned phrases', () => {
    const clean = 'Linear raised Pro from $9 to $12 quietly.';
    expect(sanitizeDraft(clean)).toBe(clean);
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 — voiceCheck() rejects "the verdict"
// ---------------------------------------------------------------------------

describe('voiceCheck — new INTEL_LEAK_PHRASES enforcement', () => {
  const ctx = { platform: 'x', useCase: 'post' } as const;

  it('rejects a draft containing "the verdict"', () => {
    const result = voiceCheck('The verdict is still out on their new pricing.', ctx);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('the verdict'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Criterion 6 — voiceCheck() rejects "scanning"
  // ---------------------------------------------------------------------------

  it('rejects a draft containing "scanning"', () => {
    const result = voiceCheck('Been scanning their changelog for shifts.', ctx);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('scanning'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Criterion 7 — voiceCheck() rejects "unchanged"
  // ---------------------------------------------------------------------------

  it('rejects a draft containing "unchanged"', () => {
    const result = voiceCheck('Pricing remained unchanged for Q2.', ctx);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('unchanged'))).toBe(true);
  });

  it('new phrases produce intelLeak: reason prefix', () => {
    for (const phrase of ['the verdict', 'scanning', 'unchanged', 'no changes', 'we observed']) {
      const result = voiceCheck(`Some copy with ${phrase} in it`, ctx);
      expect(result.ok).toBe(false);
      const match = result.reasons.find((r) => r === `intelLeak:${phrase}`);
      expect(match, `expected intelLeak:${phrase} reason`).toBeDefined();
    }
  });

  it('does not flag clean copy', () => {
    const clean = 'Linear moved Pro pricing from nine to twelve dollars per seat';
    const result = voiceCheck(clean, ctx);
    const intelLeakReasons = result.reasons.filter((r) => r.startsWith('intelLeak:'));
    expect(intelLeakReasons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AI_CLICHE_PHRASES gate in sanitizeDraft() (freeze: runtime e5ca11f)
// ---------------------------------------------------------------------------

describe('sanitizeDraft — rejects AI cliché phrases', () => {
  it('returns null for a draft containing "groundbreaking"', () => {
    expect(sanitizeDraft('furthermore, the verdict on AI tools is groundbreaking')).toBeNull();
  });

  it('returns null for a draft containing "furthermore"', () => {
    expect(sanitizeDraft('Furthermore, these results are clear.')).toBeNull();
  });

  it('returns null for a draft containing "delve"', () => {
    expect(sanitizeDraft('Let us delve into the implications of this change.')).toBeNull();
  });

  it('returns null for a draft containing "seamlessly"', () => {
    expect(sanitizeDraft('The system integrates seamlessly with existing workflows.')).toBeNull();
  });

  it('returns null for a draft containing "it is worth noting"', () => {
    expect(sanitizeDraft('It is worth noting that prices increased 30%.')).toBeNull();
  });

  it('AI cliché rejection is case-insensitive', () => {
    expect(sanitizeDraft('FURTHERMORE the pricing shifted.')).toBeNull();
    expect(sanitizeDraft('This is GROUNDBREAKING research.')).toBeNull();
  });

  it('does not reject clean drafts that contain no banned AI cliché phrases', () => {
    const clean = 'Prices went up 30%. Nobody is talking about it.';
    expect(sanitizeDraft(clean)).toBe(clean);
  });
});
