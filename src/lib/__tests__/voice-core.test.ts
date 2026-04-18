import { describe, it, expect } from 'vitest';
import {
  voiceCheck,
  autoFixCosmetic,
  FIRST_PERSON_PATTERNS,
  FAKE_EXPERIENCE_PATTERNS,
  CRINGE_TICS,
  buildVoicePrinciples,
  buildLengthDirective,
  LENGTH_CAPS,
} from '../voice/voice-core.js';

describe('voiceCheck', () => {
  const replyCtx = { platform: 'x' as const, useCase: 'reply' as const };
  const postCtx = { platform: 'x' as const, useCase: 'post' as const };

  describe('first-person', () => {
    it('rejects "I" as a pronoun', () => {
      const r = voiceCheck('I think the real bottleneck is auth', replyCtx);
      expect(r.reasons).toContain('firstPerson:I');
    });

    it("allows lowercase 'i' inside 'interesting'", () => {
      const r = voiceCheck('that is an interesting angle', replyCtx);
      expect(r.reasons.filter((x) => x.startsWith('firstPerson'))).toEqual([]);
    });

    it('rejects "we"', () => {
      const r = voiceCheck('we keep hitting the same wall', replyCtx);
      expect(r.reasons).toContain('firstPerson:we');
    });

    it('rejects lowercase "us" as pronoun', () => {
      const r = voiceCheck('let us try the other approach', replyCtx);
      expect(r.reasons).toContain('firstPerson:us');
    });

    it('allows uppercase "US" as country code', () => {
      const r = voiceCheck('US customers have different pain points', replyCtx);
      expect(r.reasons.filter((x) => x.startsWith('firstPerson'))).toEqual([]);
    });
  });

  describe('cringe tics', () => {
    it('rejects "era" as a noun', () => {
      const r = voiceCheck('agent-first era is wild', replyCtx);
      expect(r.reasons).toContain('cringe:era-noun');
    });

    it('rejects 💀 reaction emoji', () => {
      const r = voiceCheck('rate limits 💀', replyCtx);
      expect(r.reasons).toContain('cringe:reaction-emoji');
    });

    it('allows "era of" (prepositional, not the standalone tic)', () => {
      const r = voiceCheck('the era of stateless functions is over', replyCtx);
      expect(r.reasons.filter((x) => x.startsWith('cringe'))).toEqual([]);
    });
  });

  describe('length caps', () => {
    it('applies reply cap (240) for reply use-case', () => {
      const long = 'a'.repeat(241);
      expect(voiceCheck(long, replyCtx).reasons.some((r) => r.startsWith('length'))).toBe(true);
    });

    it('applies post cap (280) for post use-case — same text fits', () => {
      const mid = 'a'.repeat(250);
      expect(voiceCheck(mid, replyCtx).reasons.some((r) => r.startsWith('length'))).toBe(true);
      expect(voiceCheck(mid, postCtx).reasons.filter((r) => r.startsWith('length'))).toEqual([]);
    });
  });

  describe('clean drafts pass both use-cases', () => {
    const clean = [
      'confidence without a verifier is the default failure mode of LLM agents',
      'context rot is the quiet killer, not checkpoints',
      'claude code ships an MCP server. the first tool call is always the hardest',
    ];
    for (const text of clean) {
      it(`passes: "${text.slice(0, 50)}..."`, () => {
        expect(voiceCheck(text, replyCtx).ok).toBe(true);
        expect(voiceCheck(text, postCtx).ok).toBe(true);
      });
    }
  });
});

describe('patterns exported', () => {
  it('FIRST_PERSON_PATTERNS is non-empty', () => {
    expect(FIRST_PERSON_PATTERNS.length).toBeGreaterThan(0);
  });
  it('FAKE_EXPERIENCE_PATTERNS is non-empty', () => {
    expect(FAKE_EXPERIENCE_PATTERNS.length).toBeGreaterThan(0);
  });
  it('CRINGE_TICS is non-empty', () => {
    expect(CRINGE_TICS.length).toBeGreaterThan(0);
  });
});

describe('buildVoicePrinciples', () => {
  it('returns a string with STANCE + CRAFT + FORBIDDEN headers', () => {
    const s = buildVoicePrinciples();
    expect(s).toContain('STANCE:');
    expect(s).toContain('CRAFT:');
    expect(s).toContain('FORBIDDEN:');
  });
});

describe('autoFixCosmetic', () => {
  it('strips a single trailing period', () => {
    expect(autoFixCosmetic('Block the next 3 days.')).toBe('Block the next 3 days');
  });

  it('replaces em-dash with ", "', () => {
    expect(autoFixCosmetic('The bottleneck isn\'t tasks — it is context switching')).toBe(
      'The bottleneck isn\'t tasks, it is context switching',
    );
  });

  it('replaces en-dash with ", "', () => {
    expect(autoFixCosmetic('One rule – ship daily')).toBe('One rule, ship daily');
  });

  it('handles both violations in one draft', () => {
    expect(autoFixCosmetic('First, a reframe — then a mechanism.')).toBe(
      'First, a reframe, then a mechanism',
    );
  });

  it('no-op on already clean text', () => {
    const s = 'the bottleneck is every task feeling equal';
    expect(autoFixCosmetic(s)).toBe(s);
  });

  it('collapses doubled commas from adjacent em-dash to comma', () => {
    // input: "A, — B" (human typed comma before em-dash)
    expect(autoFixCosmetic('A, — B')).toBe('A, B');
  });

  it('does not strip mid-sentence periods', () => {
    expect(autoFixCosmetic('Mr. Jones and Dr. Smith.')).toBe('Mr. Jones and Dr. Smith');
  });

  it('handles empty string', () => {
    expect(autoFixCosmetic('')).toBe('');
  });

  it('post-fix output passes the voice gate', () => {
    const fixed = autoFixCosmetic('The bottleneck is context switching — batch it.');
    expect(voiceCheck(fixed, { platform: 'x', useCase: 'reply' }).ok).toBe(true);
  });
});

describe('buildLengthDirective', () => {
  it('mentions the correct cap for x reply', () => {
    const d = buildLengthDirective({ platform: 'x', useCase: 'reply' });
    expect(d).toContain(String(LENGTH_CAPS.x.reply));
  });
  it('mentions the correct cap for threads post', () => {
    const d = buildLengthDirective({ platform: 'threads', useCase: 'post' });
    expect(d).toContain(String(LENGTH_CAPS.threads.post));
  });
});
