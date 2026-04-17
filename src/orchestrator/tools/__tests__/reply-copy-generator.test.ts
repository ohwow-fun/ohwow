import { describe, it, expect } from 'vitest';
import { voiceCheck } from '../reply-copy-generator.js';

describe('voiceCheck', () => {
  describe('first-person pronouns', () => {
    const firstPersonCases: Array<[string, string]> = [
      ["I've lost so many threads trying to switch models mid-convo", 'firstPerson:I-contraction'],
      ['I tried this and it worked', 'firstPerson:I'],
      ["I'm not sure that tracks", 'firstPerson:I-contraction'],
      ['that happened to me once', 'firstPerson:me'],
      ['my experience says otherwise', 'firstPerson:my'],
      ['the failure mode is mine to track', 'firstPerson:mine'],
      ['we end up with merge conflicts', 'firstPerson:we'],
      ['throws us off', 'firstPerson:us'],
      ['in our stack the bottleneck is auth', 'firstPerson:our'],
    ];
    for (const [text, expected] of firstPersonCases) {
      it(`rejects "${text.slice(0, 50)}..." for ${expected}`, () => {
        const result = voiceCheck(text, 'x');
        expect(result.ok).toBe(false);
        expect(result.reasons).toContain(expected);
      });
    }

    it('allows lowercase "i" in "interesting" (word-boundary match)', () => {
      // The I/me/my patterns use word boundaries so they don't fire
      // on legitimate words. This is the common false-positive case.
      const result = voiceCheck('that is an interesting angle on the problem', 'x');
      expect(result.reasons.filter((r) => r.startsWith('firstPerson'))).toEqual([]);
    });
  });

  describe('fake-experience phrasing', () => {
    it('rejects "you end up spending more time..."', () => {
      const result = voiceCheck('you end up spending more time reconciling agent decisions', 'x');
      expect(result.ok).toBe(false);
      expect(result.reasons).toContain('fakeExperience:you-end-up');
    });

    it('rejects "in my experience"', () => {
      // Already caught by firstPerson:my, but fakeExperience adds a
      // second explicit reason for the clearer log message.
      const result = voiceCheck('in my experience that only works at low QPS', 'x');
      expect(result.ok).toBe(false);
      expect(result.reasons).toContain('fakeExperience:my-experience');
    });

    it('rejects "when you try"', () => {
      const result = voiceCheck('when you try parallel branches the merge gets ugly', 'x');
      expect(result.ok).toBe(false);
      expect(result.reasons).toContain('fakeExperience:when-you-try');
    });
  });

  describe('structural forbidden', () => {
    it('rejects em dashes', () => {
      const result = voiceCheck('the bottleneck — not auth — is context rot', 'x');
      expect(result.reasons).toContain('emDash');
    });

    it('rejects "please"', () => {
      const result = voiceCheck('consider using a verifier please', 'x');
      expect(result.reasons).toContain('please');
    });

    it('rejects hashtags', () => {
      const result = voiceCheck('context rot is underrated #LLMs', 'x');
      expect(result.reasons).toContain('hashtag');
    });

    it('rejects trailing period', () => {
      const result = voiceCheck('confidence without a verifier is the default failure mode.', 'x');
      expect(result.reasons).toContain('trailingPeriod');
    });
  });

  describe('clean drafts pass', () => {
    const cleanDrafts = [
      'confidence without a verifier is the default failure mode of LLM agents right now',
      'compaction is the quiet one. most long-running agents die from it, not lack of checkpoints',
      'parallel execution plus shared memory is the real fork in the road',
    ];
    for (const text of cleanDrafts) {
      it(`passes observational draft "${text.slice(0, 60)}..."`, () => {
        const result = voiceCheck(text, 'x');
        expect(result.ok).toBe(true);
        expect(result.reasons).toEqual([]);
      });
    }
  });

  describe('length', () => {
    it('rejects X drafts over 240 chars', () => {
      const long = 'a'.repeat(241);
      const result = voiceCheck(long, 'x');
      expect(result.reasons.some((r) => r.startsWith('length'))).toBe(true);
    });

    it('allows Threads drafts up to 280 chars', () => {
      const threads = 'a'.repeat(280);
      const result = voiceCheck(threads, 'threads');
      expect(result.reasons.filter((r) => r.startsWith('length'))).toEqual([]);
    });
  });
});
