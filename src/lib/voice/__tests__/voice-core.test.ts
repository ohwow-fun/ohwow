import { describe, it, expect } from 'vitest';
import {
  voiceCheck,
  INTEL_LEAK_PHRASES,
  FIRST_PERSON_PATTERNS,
} from '../voice-core.js';

// ---------------------------------------------------------------------------
// voiceCheck — INTEL_LEAK_PHRASES enforcement
// Phase: deprecate X channel / content-gen prompts fix
// ---------------------------------------------------------------------------

describe('voiceCheck — INTEL_LEAK_PHRASES rejection', () => {
  const ctx = { platform: 'x', useCase: 'post' } as const;

  it('rejects a draft containing "verdict flipped"', () => {
    const result = voiceCheck('Interesting that the verdict flipped on their roadmap', ctx);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('verdict flipped'))).toBe(true);
  });

  it('rejects a draft containing "latest scan"', () => {
    const result = voiceCheck('Our latest scan of their pricing page found changes', ctx);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('latest scan'))).toBe(true);
  });

  it("rejects a draft containing \"we've been watching\"", () => {
    const result = voiceCheck("We've been watching this company for months", ctx);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("we've been watching"))).toBe(true);
  });

  it('intel-leak check is case-insensitive', () => {
    expect(voiceCheck('VERDICT FLIPPED on pricing', ctx).ok).toBe(false);
    expect(voiceCheck('Latest Scan turned up a delta', ctx).ok).toBe(false);
    expect(voiceCheck("WE'VE BEEN WATCHING this space", ctx).ok).toBe(false);
  });

  it('each banned phrase produces a reason prefixed with "intelLeak:"', () => {
    for (const phrase of INTEL_LEAK_PHRASES) {
      const result = voiceCheck(`Some copy with ${phrase} embedded`, ctx);
      expect(result.ok).toBe(false);
      const match = result.reasons.find((r) => r === `intelLeak:${phrase}`);
      expect(match).toBeDefined();
    }
  });

  it('does not flag clean copy that contains none of the banned phrases', () => {
    const clean = 'Linear raised Pro from nine to twelve dollars';
    const result = voiceCheck(clean, ctx);
    // Filter out any non-intel-leak reasons; only assert no intelLeak reason fired.
    const intelLeakReasons = result.reasons.filter((r) => r.startsWith('intelLeak:'));
    expect(intelLeakReasons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// voiceCheck — existing gate smoke tests (ensure nothing regressed)
// ---------------------------------------------------------------------------

describe('voiceCheck — structural rejections', () => {
  const ctx = { platform: 'x', useCase: 'reply' } as const;

  it('rejects em dashes', () => {
    const result = voiceCheck('Something happened — worth noting', ctx);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('emDash');
  });

  it('rejects hashtags', () => {
    const result = voiceCheck('Big news #AI', ctx);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('hashtag');
  });

  it('rejects "please"', () => {
    const result = voiceCheck('Please share your thoughts', ctx);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('please');
  });

  it('rejects first-person "I"', () => {
    const result = voiceCheck('I noticed this yesterday', ctx);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.startsWith('firstPerson:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INTEL_LEAK_PHRASES export shape
// ---------------------------------------------------------------------------

describe('INTEL_LEAK_PHRASES export', () => {
  it('exports an array of at least 3 phrases', () => {
    expect(Array.isArray(INTEL_LEAK_PHRASES)).toBe(true);
    expect(INTEL_LEAK_PHRASES.length).toBeGreaterThanOrEqual(3);
  });

  it('includes the three phrases named in the plan', () => {
    expect(INTEL_LEAK_PHRASES).toContain('verdict flipped');
    expect(INTEL_LEAK_PHRASES).toContain('latest scan');
    expect(INTEL_LEAK_PHRASES).toContain("we've been watching");
  });
});
