/**
 * Freeze tests for the humanization-polish trio (2026-04-19).
 *
 * Criteria under test (9 total):
 *  1. sanitizeDraft("The X happened") returns null (openingThe blocked via voiceCheck)
 *  2. sanitizeDraft("I've been watching") returns null (firstPerson:I-contraction blocked)
 *  3. sanitizeDraft("clean draft without violations") returns the string unchanged
 *  4. buildPrompt() string contains "Threads feed"
 *  5. buildPrompt() string does NOT contain "X timeline"
 *  6. buildPrompt() uses the threads length cap (500), not the X cap (280)
 *  7. buildVoicePrinciples() output contains a prohibition on category-level trend labeling
 *  8. buildDraftMessage('x_dm', ...) does NOT start with "Hey "
 *  9. buildDraftMessage('x_dm', ...) does NOT contain "compare notes"
 * 10. buildDraftMessage('x_dm', ...) passes voiceCheck
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
const { buildVoicePrinciples, voiceCheck } = await import('../../lib/voice/voice-core.js');
const { buildDraftMessage } = await import('../../self-bench/experiments/outreach-thermostat.js');

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

/** Minimal ChannelPlan for x_dm tests. */
function makeXDmPlan(overrides: Partial<import('../../self-bench/experiments/outreach-thermostat.js').ChannelPlan> = {}): import('../../self-bench/experiments/outreach-thermostat.js').ChannelPlan {
  return {
    contact_id: 'c-1',
    display_name: 'Test User',
    channel: 'x_dm',
    reason: 'has_x_user_id',
    handle: 'testuser',
    permalink: null,
    bucket: null,
    x_user_id: 'x-user-123',
    conversation_pair: null,
    email: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Criterion 1 — sanitizeDraft rejects "The X happened" (openingThe gate)
// ---------------------------------------------------------------------------

describe('sanitizeDraft — openingThe gate (criterion 1)', () => {
  it('returns null for a draft starting with "The "', () => {
    expect(sanitizeDraft('The AI market shifted this quarter')).toBeNull();
  });

  it('returns null for "The X happened" pattern', () => {
    expect(sanitizeDraft('The price increase happened without announcement')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — sanitizeDraft rejects I-contraction (firstPerson gate)
// ---------------------------------------------------------------------------

describe("sanitizeDraft — firstPerson:I-contraction gate (criterion 2)", () => {
  it("returns null for a draft containing \"I've been\"", () => {
    expect(sanitizeDraft("I've been watching this space for months")).toBeNull();
  });

  it("returns null for other I-contractions like \"I'm\"", () => {
    expect(sanitizeDraft("I'm tracking something interesting here")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — sanitizeDraft passes clean draft unchanged
// ---------------------------------------------------------------------------

describe('sanitizeDraft — clean draft passes through (criterion 3)', () => {
  it('returns the clean draft unchanged', () => {
    const clean = 'Linear raised Pro pricing from nine to twelve dollars quietly';
    expect(sanitizeDraft(clean)).toBe(clean);
  });

  it('returns null for SKIP response', () => {
    expect(sanitizeDraft('SKIP')).toBeNull();
  });

  it('strips leading Post: prefix and returns the body', () => {
    expect(sanitizeDraft('Post: Linear raised Pro pricing from nine to twelve dollars')).toBe(
      'Linear raised Pro pricing from nine to twelve dollars',
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 — buildPrompt() contains "Threads feed"
// ---------------------------------------------------------------------------

describe('buildPrompt — Threads platform identity (criterion 4)', () => {
  it('contains "Threads feed" in the prompt', () => {
    const prompt = buildPrompt(makeInsight());
    expect(prompt).toContain('Threads feed');
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 — buildPrompt() does NOT contain "X timeline"
// ---------------------------------------------------------------------------

describe('buildPrompt — no "X timeline" reference (criterion 5)', () => {
  it('does not contain "X timeline" in the prompt', () => {
    const prompt = buildPrompt(makeInsight());
    expect(prompt).not.toContain('X timeline');
  });
});

// ---------------------------------------------------------------------------
// Criterion 6 — buildPrompt() uses threads 500-char cap, not X 280
// ---------------------------------------------------------------------------

describe('buildPrompt — threads length cap 500 (criterion 6)', () => {
  it('contains "hard cap 500" from buildLengthDirective threads/post', () => {
    const prompt = buildPrompt(makeInsight());
    expect(prompt).toContain('hard cap 500');
  });

  it('does not use the X 280 cap', () => {
    const prompt = buildPrompt(makeInsight());
    expect(prompt).not.toContain('hard cap 280');
  });
});

// ---------------------------------------------------------------------------
// Criterion 7 — buildVoicePrinciples() contains category-label prohibition
// ---------------------------------------------------------------------------

describe('buildVoicePrinciples — category-label ban (criterion 7)', () => {
  it('contains the category-level trend labeling prohibition', () => {
    const principles = buildVoicePrinciples();
    expect(principles).toContain('NEVER narrate the movement at the category level');
  });

  it('names specific actor prohibition examples', () => {
    const principles = buildVoicePrinciples();
    // The prohibition should name specific actor and specific change
    expect(principles).toContain('Name the specific actor and the specific change');
  });
});

// ---------------------------------------------------------------------------
// Criterion 8 — buildDraftMessage('x_dm') does NOT start with "Hey "
// ---------------------------------------------------------------------------

describe('buildDraftMessage — x_dm opener (criterion 8)', () => {
  it('does not start with "Hey "', () => {
    const plan = makeXDmPlan();
    const result = buildDraftMessage('x_dm', plan);
    expect(typeof result).toBe('string');
    expect((result as string).startsWith('Hey ')).toBe(false);
  });

  it('does not start with "Hey " regardless of bucket', () => {
    for (const bucket of ['market_signal', 'competitors', null]) {
      const plan = makeXDmPlan({ bucket });
      const result = buildDraftMessage('x_dm', plan);
      expect((result as string).startsWith('Hey ')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 9 — buildDraftMessage('x_dm') does NOT contain "compare notes"
// ---------------------------------------------------------------------------

describe('buildDraftMessage — x_dm no "compare notes" (criterion 9)', () => {
  it('does not contain "compare notes"', () => {
    const plan = makeXDmPlan();
    const result = buildDraftMessage('x_dm', plan);
    expect(typeof result).toBe('string');
    expect((result as string).toLowerCase()).not.toContain('compare notes');
  });
});

// ---------------------------------------------------------------------------
// Criterion 10 — buildDraftMessage('x_dm') passes voiceCheck
// ---------------------------------------------------------------------------

describe('buildDraftMessage — x_dm passes voiceCheck (criterion 10)', () => {
  it('passes voiceCheck for x/reply context', () => {
    const plan = makeXDmPlan();
    const result = buildDraftMessage('x_dm', plan);
    expect(typeof result).toBe('string');
    const { ok, reasons } = voiceCheck(result as string, { platform: 'x', useCase: 'reply' });
    expect(ok, `voiceCheck failed: ${reasons.join(', ')}`).toBe(true);
  });

  it('passes voiceCheck for market_signal bucket', () => {
    const plan = makeXDmPlan({ bucket: 'market_signal' });
    const result = buildDraftMessage('x_dm', plan);
    const { ok, reasons } = voiceCheck(result as string, { platform: 'x', useCase: 'reply' });
    expect(ok, `voiceCheck failed: ${reasons.join(', ')}`).toBe(true);
  });

  it('passes voiceCheck for competitors bucket', () => {
    const plan = makeXDmPlan({ bucket: 'competitors' });
    const result = buildDraftMessage('x_dm', plan);
    const { ok, reasons } = voiceCheck(result as string, { platform: 'x', useCase: 'reply' });
    expect(ok, `voiceCheck failed: ${reasons.join(', ')}`).toBe(true);
  });
});
