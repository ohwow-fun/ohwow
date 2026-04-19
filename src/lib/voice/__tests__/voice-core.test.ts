import { describe, it, expect } from 'vitest';
import {
  voiceCheck,
  INTEL_LEAK_PHRASES,
  AI_CLICHE_PHRASES,
  FIRST_PERSON_PATTERNS,
  buildVoicePrinciples,
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

// ---------------------------------------------------------------------------
// voiceCheck — AI_CLICHE_PHRASES gate (freeze: runtime e5ca11f)
// ---------------------------------------------------------------------------

describe('voiceCheck — AI cliché phrases', () => {
  const ctx = { platform: 'x', useCase: 'post' } as const;

  it('flags "fascinating" and "groundbreaking"', () => {
    const r = voiceCheck('This is a fascinating and groundbreaking approach', ctx);
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(expect.arrayContaining(['aiCliche:fascinating', 'aiCliche:groundbreaking']));
  });

  it('flags "to summarize", "it is worth noting", "seamlessly"', () => {
    const r = voiceCheck('To summarize, it is worth noting that the system works seamlessly', ctx);
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(expect.arrayContaining([
      'aiCliche:to summarize',
      'aiCliche:it is worth noting',
      'aiCliche:seamlessly',
    ]));
  });

  it('flags "furthermore"', () => {
    const r = voiceCheck('Furthermore, the results are clear', ctx);
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('aiCliche:furthermore');
  });

  it('cliché check is case-insensitive', () => {
    expect(voiceCheck('FURTHERMORE the data shows', ctx).reasons).toContain('aiCliche:furthermore');
    expect(voiceCheck('GROUNDBREAKING research', ctx).reasons).toContain('aiCliche:groundbreaking');
  });

  it('each banned phrase produces a reason prefixed with "aiCliche:"', () => {
    for (const phrase of AI_CLICHE_PHRASES) {
      const result = voiceCheck(`Some copy with ${phrase} embedded`, ctx);
      const match = result.reasons.find((r) => r === `aiCliche:${phrase}`);
      expect(match, `expected aiCliche:${phrase} reason`).toBeDefined();
    }
  });

  it('clean post passes cliché gate', () => {
    const r = voiceCheck('The numbers are out. Nobody is building what the demand is asking for.', ctx);
    // Note: this triggers openingThe — only assert no aiCliche: reasons
    expect(r.reasons.filter((x) => x.startsWith('aiCliche:'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AI_CLICHE_PHRASES export shape
// ---------------------------------------------------------------------------

describe('AI_CLICHE_PHRASES export', () => {
  it('exports an array of at least 20 phrases', () => {
    expect(Array.isArray(AI_CLICHE_PHRASES)).toBe(true);
    expect(AI_CLICHE_PHRASES.length).toBeGreaterThanOrEqual(20);
  });

  it('contains the core AI fingerprint words', () => {
    expect(AI_CLICHE_PHRASES).toContain('delve');
    expect(AI_CLICHE_PHRASES).toContain('fascinating');
    expect(AI_CLICHE_PHRASES).toContain('groundbreaking');
    expect(AI_CLICHE_PHRASES).toContain('furthermore');
    expect(AI_CLICHE_PHRASES).toContain('seamlessly');
    expect(AI_CLICHE_PHRASES).toContain('in conclusion');
    expect(AI_CLICHE_PHRASES).toContain('to summarize');
    expect(AI_CLICHE_PHRASES).toContain('it is worth noting');
  });
});

// ---------------------------------------------------------------------------
// buildVoicePrinciples — FORBIDDEN section contains AI cliché vocabulary
// (freeze: runtime e5ca11f)
// ---------------------------------------------------------------------------

describe('buildVoicePrinciples — FORBIDDEN section', () => {
  it('mentions AI cliché words in the FORBIDDEN section', () => {
    const principles = buildVoicePrinciples();
    expect(principles).toContain('delve');
    expect(principles).toContain('furthermore');
    expect(principles).toContain('in conclusion');
    expect(principles).toContain('groundbreaking');
  });

  it('contains the AI CLICHÉ WORDS label', () => {
    const principles = buildVoicePrinciples();
    expect(principles).toContain('AI CLICHÉ WORDS');
  });

  it('contains the AI CLICHÉ STRUCTURES label', () => {
    const principles = buildVoicePrinciples();
    expect(principles).toContain('AI CLICHÉ STRUCTURES');
  });

  it('still contains STANCE and CRAFT sections', () => {
    const principles = buildVoicePrinciples();
    expect(principles).toContain('STANCE:');
    expect(principles).toContain('CRAFT:');
    expect(principles).toContain('FORBIDDEN:');
  });
});
